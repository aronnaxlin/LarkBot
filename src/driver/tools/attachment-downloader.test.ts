import { describe, expect, it, vi } from 'vitest';

import { createAttachmentDownloader } from './attachment-downloader';
import type { Attachment } from '../../telegram/message/types';

// Synthetic identifiers only; no real chat content.
const CHAT = 'oc_synthetic_group';

const fixture = (attachments: Attachment[] | undefined) => {
  const loadMessageAttachments = vi.fn(() => attachments);
  const downloadMessageMedia = vi.fn(async () => Buffer.from('synthetic-bytes'));
  const download = createAttachmentDownloader({ chatId: CHAT, loadMessageAttachments, downloadMessageMedia });
  return { download, loadMessageAttachments, downloadMessageMedia };
};

describe('createAttachmentDownloader', () => {
  it('passes the parsed attachment index through to the platform download', async () => {
    const { download, downloadMessageMedia } = fixture([{ type: 'photo' }, { type: 'photo' }]);
    await expect(download('om_multi:1')).resolves.toEqual(Buffer.from('synthetic-bytes'));
    expect(downloadMessageMedia).toHaveBeenCalledWith(CHAT, 'om_multi', 1);
  });

  it('downloads index 0 of a multi-attachment message', async () => {
    const { download, downloadMessageMedia } = fixture([{ type: 'photo' }, { type: 'photo' }]);
    await download('om_multi:0');
    expect(downloadMessageMedia).toHaveBeenCalledWith(CHAT, 'om_multi', 0);
  });

  it('rejects an out-of-range index without calling the platform', async () => {
    const { download, downloadMessageMedia } = fixture([{ type: 'photo' }]);
    await expect(download('om_multi:1')).rejects.toThrow('out of range');
    expect(downloadMessageMedia).not.toHaveBeenCalled();
  });

  it('rejects missing attachments and malformed file ids', async () => {
    const { download, downloadMessageMedia } = fixture(undefined);
    await expect(download('om_x:0')).rejects.toThrow('No attachments found');
    await expect(download('om_x')).rejects.toThrow('Invalid file_id format');
    await expect(download(':0')).rejects.toThrow('index is not a valid number');
    expect(downloadMessageMedia).not.toHaveBeenCalled();
  });

  it('rejects an empty download result', async () => {
    const download = createAttachmentDownloader({
      chatId: CHAT,
      loadMessageAttachments: () => [{ type: 'photo' }],
      downloadMessageMedia: async () => undefined,
    });
    await expect(download('om_x:0')).rejects.toThrow('Failed to download attachment');
  });
});
