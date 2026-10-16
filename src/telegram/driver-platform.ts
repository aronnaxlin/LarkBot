import type { TelegramDriverHooks } from './driver-hooks';
import { parseTelegramMessageId, requireTelegramMessageId } from './message/id-conversion';
import type { Attachment } from './message/types';
import type { BanSpammerResult } from './moderation-types';
import type { DriverPlatform } from '../driver/platform';

export const createTelegramDriverPlatform = (deps: {
  hooks: TelegramDriverHooks;
  messageExists: (chatId: string, messageId: number) => boolean;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  banSpammer: (chatId: string, messageId: number) => Promise<BanSpammerResult>;
}): DriverPlatform => ({
  name: 'telegram',
  sendMessage: async (chatId, text, replyToMessageId, attachments) => {
    const sent = await deps.hooks.sendMessage(
      chatId,
      text,
      replyToMessageId == null ? undefined : requireTelegramMessageId(replyToMessageId),
      attachments,
    );
    return { messageId: String(sent.messageId) };
  },
  setMessageReaction: async (chatId, messageId, emoji) =>
    await deps.hooks.setMessageReaction(chatId, requireTelegramMessageId(messageId), emoji),
  sendTypingAction: deps.hooks.sendTypingAction,
  onDebounceStateChange: deps.hooks.onDebounceStateChange,
  // TDLib aborts the process on malformed ids, so non-numeric ids never pass.
  messageExists: (chatId, messageId) => {
    const id = parseTelegramMessageId(messageId);
    return id != null && deps.messageExists(chatId, id);
  },
  loadMessageAttachments: (chatId, messageId) => {
    const id = parseTelegramMessageId(messageId);
    return id == null ? undefined : deps.loadMessageAttachments(chatId, id);
  },
  downloadMessageMedia: async (chatId, messageId) =>
    await deps.hooks.downloadMessageMedia(chatId, requireTelegramMessageId(messageId)),
  banSpammer: async (chatId, messageId) => await deps.banSpammer(chatId, requireTelegramMessageId(messageId)),
});
