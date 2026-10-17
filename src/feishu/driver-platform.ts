import { randomUUID } from 'node:crypto';

import type { Logger } from '@guiiai/logg';

import { FeishuApiError } from './api';
import type { FeishuApi } from './api';
import { buildPostContent } from './post-content';
import { createFeishuReactions } from './reactions';
import type { CanonicalMessageEvent } from '../adaptation/types';
import type { DriverPlatform } from '../driver/platform';

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const createFeishuDriverPlatform = (deps: {
  api: Pick<FeishuApi, 'sendPost' | 'createReaction' | 'deleteReaction'>;
  botInfo: () => { openId: string; name: string };
  acceptSelfSent: (event: CanonicalMessageEvent) => void;
  messageExists: (chatId: string, messageId: string) => boolean;
  // Whether an open_id belongs to a participant seen in this chat; outgoing
  // mentions of anyone else are rejected before the send.
  isKnownParticipant: (chatId: string, openId: string) => boolean;
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
      const { content, nodes } = buildPostContent(text, openId => deps.isKnownParticipant(chatId, openId));
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
        content: nodes,
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
