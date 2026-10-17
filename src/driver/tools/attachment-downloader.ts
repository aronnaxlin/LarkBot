import type { Attachment } from '../../telegram/message/types';

export const createAttachmentDownloader = (deps: {
  chatId: string;
  loadMessageAttachments: (chatId: string, messageId: string) => Attachment[] | undefined;
  downloadMessageMedia: (chatId: string, messageId: string, index: number) => Promise<Buffer | undefined>;
  // Rendered `file-id` values carry a message alias; resolve it to the
  // canonical id before any platform lookup. Canonical ids pass through.
  resolveMessageId?: (messageId: string) => string;
}): (fileId: string) => Promise<Buffer> =>
  async (fileId: string): Promise<Buffer> => {
    const colonIdx = fileId.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid file_id format. Expected "messageId:index".');

    // Message IDs are opaque platform strings (e.g. Feishu `om_...`); only the
    // index after the last colon is numeric.
    const rawMessageId = fileId.slice(0, colonIdx);
    const messageId = rawMessageId === '' ? rawMessageId : (deps.resolveMessageId?.(rawMessageId) ?? rawMessageId);
    const indexText = fileId.slice(colonIdx + 1);
    const attachmentIndex = /^\d+$/.test(indexText) ? Number(indexText) : NaN;
    if (messageId === '' || isNaN(attachmentIndex))
      throw new Error('Invalid file_id: messageId is empty or index is not a valid number.');

    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0)
      throw new Error(`No attachments found for message ${messageId}.`);
    if (attachmentIndex < 0 || attachmentIndex >= attachments.length)
      throw new Error(`Attachment index ${attachmentIndex} is out of range for message ${messageId} (${attachments.length} attachment(s)).`);

    const buffer = await deps.downloadMessageMedia(deps.chatId, messageId, attachmentIndex);
    if (!buffer)
      throw new Error(`Failed to download attachment ${fileId}.`);

    return buffer;
  };
