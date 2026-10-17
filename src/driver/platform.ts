import type { SendMessageAttachment } from './tools';
import type { Attachment } from '../telegram/message/types';
import type { BanSpammerResult } from '../telegram/moderation-types';

// Driver-facing chat platform capabilities. Message IDs are canonical strings;
// any numeric conversion belongs inside the platform implementation.
//
// Optional members are capabilities: when absent, the corresponding tools (or
// tool parameters) are not exposed to the model at all.
export interface DriverPlatform {
  // Platform name for prompts (`currentChannel`).
  name: 'telegram' | 'feishu';
  sendMessage: (
    chatId: string,
    text: string,
    replyToMessageId?: string,
    attachments?: SendMessageAttachment[],
  ) => Promise<{ messageId: string }>;
  setMessageReaction: (chatId: string, messageId: string, emoji: string | undefined) => Promise<void>;
  sendTypingAction: (chatId: string) => Promise<void>;
  // Called when a chat enters (true) / leaves (false) its debounce window, so the
  // host can run an active typing poll for large supergroups only while waiting.
  onDebounceStateChange: (chatId: string, isDebouncing: boolean) => void;
  // Gate for LLM-supplied message IDs before any platform API call.
  messageExists: (chatId: string, messageId: string) => boolean;
  // Inbound media: `download_file` and `read_image(file_id)`. Provided
  // together or not at all.
  loadMessageAttachments?: (chatId: string, messageId: string) => Attachment[] | undefined;
  downloadMessageMedia?: (chatId: string, messageId: string, index: number) => Promise<Buffer | undefined>;
  // Outbound media: exposes the `attachments` parameter on `send_message`.
  // Declared separately because a platform can support inbound downloads while
  // still being unable to send attachments (Feishu today).
  supportsOutboundAttachments?: boolean;
  banSpammer?: (chatId: string, messageId: string) => Promise<BanSpammerResult>;
}
