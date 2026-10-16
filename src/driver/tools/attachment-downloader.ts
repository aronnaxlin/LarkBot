import type { Attachment } from '../../telegram/message/types';

export const createAttachmentDownloader = (deps: {
  chatId: string;
  loadMessageAttachments: (chatId: string, messageId: string) => Attachment[] | undefined;
  downloadMessageMedia: (chatId: string, messageId: string) => Promise<Buffer | undefined>;
}): (fileId: string) => Promise<Buffer> =>
  async (fileId: string): Promise<Buffer> => {
    const colonIdx = fileId.lastIndexOf(':');
    if (colonIdx < 0) throw new Error('Invalid file_id format. Expected "messageId:index".');

    // Message IDs are opaque platform strings (e.g. Feishu `om_...`); only the
    // index after the last colon is numeric.
    const messageId = fileId.slice(0, colonIdx);
    const indexText = fileId.slice(colonIdx + 1);
    const attachmentIndex = /^\d+$/.test(indexText) ? Number(indexText) : NaN;
    if (messageId === '' || isNaN(attachmentIndex))
      throw new Error('Invalid file_id: messageId is empty or index is not a valid number.');

    const attachments = deps.loadMessageAttachments(deps.chatId, messageId);
    if (!attachments || attachments.length === 0)
      throw new Error(`No attachments found for message ${messageId}.`);
    if (attachments.length !== 1 || attachmentIndex !== 0)
      throw new Error('Telegram messages must expose exactly one downloadable attachment at index 0');

    const buffer = await deps.downloadMessageMedia(deps.chatId, messageId);
    if (!buffer)
      throw new Error('Failed to download file from Telegram.');

    return buffer;
  };
