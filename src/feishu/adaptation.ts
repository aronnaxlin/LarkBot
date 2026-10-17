import { parseFeishuAttachments, parseFeishuContent } from './content';
import type { FeishuMessageReceiveEvent, FeishuMessageRecalledEvent } from './events';
import type { CanonicalDeleteEvent, CanonicalMessageEvent, CanonicalUser } from '../adaptation/types';

export interface FeishuIngressMeta {
  receivedAtMs: number;
  utcOffsetMin: number;
}

// Feishu event deliveries can repeat (3-second ack timeout, platform retries).
// Keys are per action kind so a recall never suppresses the message it targets.
export const messageDedupKey = (messageId: string): string => `message:${messageId}`;
export const recallDedupKey = (messageId: string): string => `recall:${messageId}`;

// Stable identity is the app-scoped open_id. Events from senders without one
// (should not happen for group members) cannot be attributed and are rejected.
export const feishuSenderOpenId = (event: FeishuMessageReceiveEvent): string => {
  const openId = event.sender.sender_id?.open_id;
  if (!openId) throw new Error(`Feishu message ${event.message.message_id} has no sender open_id`);
  return openId;
};

export const adaptFeishuMessage = (
  event: FeishuMessageReceiveEvent,
  sender: CanonicalUser,
  meta: FeishuIngressMeta,
): CanonicalMessageEvent => {
  const { message } = event;
  const canonical: CanonicalMessageEvent = {
    type: 'message',
    chatId: message.chat_id,
    messageId: message.message_id,
    sender,
    receivedAtMs: meta.receivedAtMs,
    timestampSec: Math.floor(Number(message.create_time) / 1000),
    utcOffsetMin: meta.utcOffsetMin,
    content: parseFeishuContent(message.message_type, message.content, message.mentions),
    attachments: parseFeishuAttachments(message.message_type, message.content),
  };
  // parent_id is the directly quoted message; root_id/thread_id are not used
  // because LarkBot keeps one context per chat.
  if (message.parent_id) canonical.replyToMessageId = message.parent_id;
  return canonical;
};

export const adaptFeishuRecall = (
  event: FeishuMessageRecalledEvent,
  meta: FeishuIngressMeta,
): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: event.chat_id,
  messageIds: [event.message_id],
  receivedAtMs: meta.receivedAtMs,
  timestampSec: event.recall_time
    ? Math.floor(Number(event.recall_time) / 1000)
    : Math.floor(meta.receivedAtMs / 1000),
  utcOffsetMin: meta.utcOffsetMin,
});
