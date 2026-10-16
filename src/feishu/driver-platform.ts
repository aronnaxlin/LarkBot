import { randomUUID } from 'node:crypto';

import type { Logger } from '@guiiai/logg';

import { FeishuApiError } from './api';
import type { FeishuApi } from './api';
import { createFeishuReactions } from './reactions';
import type { CanonicalMessageEvent } from '../adaptation/types';
import type { DriverPlatform } from '../driver/platform';

// Feishu caps post/card request bodies at 30 KB. Leave headroom for the other
// request fields rather than letting the server reject the call.
const MAX_POST_CONTENT_BYTES = 28 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

// Markdown is sent as a single `md` element of a `post` message; Feishu renders
// CommonMark + GFM there. Telegram-only syntax (e.g. spoilers) is not converted.
export const buildPostContent = (markdown: string): string => {
  if (markdown.trim() === '') throw new Error('Message text is empty.');
  const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } });
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_POST_CONTENT_BYTES)
    throw new Error(`Message is too long for Feishu (${bytes} bytes encoded; limit ${MAX_POST_CONTENT_BYTES}). Split it into several shorter messages.`);
  return content;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const createFeishuDriverPlatform = (deps: {
  api: Pick<FeishuApi, 'sendPost' | 'createReaction' | 'deleteReaction'>;
  botInfo: () => { openId: string; name: string };
  acceptSelfSent: (event: CanonicalMessageEvent) => void;
  messageExists: (chatId: string, messageId: string) => boolean;
  logger: Logger;
  retryDelaysMs?: readonly number[];
  newUuid?: () => string;
  now?: () => number;
}): DriverPlatform => {
  const log = deps.logger.withContext('feishu:send');
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const newUuid = deps.newUuid ?? randomUUID;
  const now = deps.now ?? Date.now;
  const reactions = createFeishuReactions(deps.api);

  // One uuid per logical message: every retry of the same send reuses it, so
  // Feishu deduplicates a retry whose earlier attempt actually succeeded.
  // Retries are bounded and only for rate limits, 5xx, and lost responses;
  // the final error reaches the tool result.
  const sendWithRetry = async (params: Parameters<FeishuApi['sendPost']>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.api.sendPost(params);
      } catch (error) {
        const delayMs = retryDelaysMs[attempt];
        if (!(error instanceof FeishuApiError) || !error.retryable || delayMs == null) throw error;
        log.withFields({ chatId: params.chatId, attempt: attempt + 1, retryInMs: delayMs, error: error.message })
          .warn('Feishu send failed; retrying with the same uuid');
        await sleep(delayMs);
      }
    }
  };

  return {
    name: 'feishu',
    sendMessage: async (chatId, text, replyToMessageId, attachments) => {
      if (attachments != null && attachments.length > 0)
        throw new Error('Feishu attachments are not supported yet.');
      const content = buildPostContent(text);
      const sent = await sendWithRetry({ chatId, replyToMessageId, content, uuid: newUuid() });

      const bot = deps.botInfo();
      const receivedAtMs = now();
      const event: CanonicalMessageEvent = {
        type: 'message',
        chatId,
        messageId: sent.messageId,
        sender: { id: bot.openId, displayName: bot.name, isBot: true },
        receivedAtMs,
        timestampSec: Math.floor(sent.createTimeMs / 1000),
        utcOffsetMin: -new Date(receivedAtMs).getTimezoneOffset(),
        content: [{ type: 'text', text }],
        attachments: [],
        isSelfSent: true,
      };
      if (replyToMessageId) event.replyToMessageId = replyToMessageId;
      // The message is already delivered; failing the tool here would invite
      // the model to send it again. Cold replay picks the event up if it was
      // persisted before the failure.
      try {
        deps.acceptSelfSent(event);
      } catch (error) {
        log.withError(error).withFields({ chatId, messageId: sent.messageId }).error('Sent message could not be recorded as a self-event');
      }
      return { messageId: sent.messageId };
    },
    setMessageReaction: (_chatId, messageId, emoji) => reactions.setReaction(messageId, emoji),
    // Feishu has no bot typing indicator API; chats should set sendTypingAction: false.
    sendTypingAction: async () => {},
    onDebounceStateChange: () => {},
    messageExists: deps.messageExists,
  };
};
