import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { createFeishuDriverPlatform } from './driver-platform';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('feishu-driver-platform-test');

// Synthetic identifiers only; no real chat content or names.
const CHAT = 'oc_synthetic_group';
const MESSAGE = 'om_synthetic_1';

const baseDeps = () => ({
  api: { sendPost: vi.fn(), createReaction: vi.fn(), deleteReaction: vi.fn() },
  botInfo: () => ({ openId: 'ou_synthetic_bot', name: 'LarkBot' }),
  acceptSelfSent: vi.fn(),
  messageExists: vi.fn(() => true),
  isKnownParticipant: () => true,
  logger,
});

describe('Feishu driver platform attachment capability', () => {
  it('is absent unless the host wires both halves', () => {
    const platform = createFeishuDriverPlatform(baseDeps());
    expect(platform.loadMessageAttachments).toBeUndefined();
    expect(platform.downloadMessageMedia).toBeUndefined();
  });

  it('rejects a half-wired capability', () => {
    expect(() => createFeishuDriverPlatform({ ...baseDeps(), loadMessageAttachments: () => [] }))
      .toThrow('requires both');
  });

  it('downloads the fileKey of the requested attachment index', async () => {
    const getMessageResource = vi.fn(async (params: { fileKey: string }) => Buffer.from(params.fileKey));
    const platform = createFeishuDriverPlatform({
      ...baseDeps(),
      loadMessageAttachments: () => [
        { type: 'photo', fileKey: 'img_v3_first' },
        { type: 'photo', fileKey: 'img_v3_second' },
      ],
      getMessageResource,
    });
    expect(platform.loadMessageAttachments?.(CHAT, MESSAGE)).toEqual([
      { type: 'photo', fileKey: 'img_v3_first' },
      { type: 'photo', fileKey: 'img_v3_second' },
    ]);
    await expect(platform.downloadMessageMedia!(CHAT, MESSAGE, 0)).resolves.toEqual(Buffer.from('img_v3_first'));
    await expect(platform.downloadMessageMedia!(CHAT, MESSAGE, 1)).resolves.toEqual(Buffer.from('img_v3_second'));
    expect(getMessageResource).toHaveBeenNthCalledWith(1, {
      messageId: MESSAGE,
      fileKey: 'img_v3_first',
      type: 'image',
    });
    expect(getMessageResource).toHaveBeenNthCalledWith(2, {
      messageId: MESSAGE,
      fileKey: 'img_v3_second',
      type: 'image',
    });
  });

  it('returns undefined instead of calling the API when the message has no attachments', async () => {
    const getMessageResource = vi.fn(async () => Buffer.from('synthetic-bytes'));
    const platform = createFeishuDriverPlatform({
      ...baseDeps(),
      loadMessageAttachments: () => [],
      getMessageResource,
    });
    await expect(platform.downloadMessageMedia!(CHAT, MESSAGE, 0)).resolves.toBeUndefined();
    expect(getMessageResource).not.toHaveBeenCalled();
  });

  it('throws an invariant error when a stored attachment has no fileKey', async () => {
    const getMessageResource = vi.fn(async () => Buffer.from('synthetic-bytes'));
    const platform = createFeishuDriverPlatform({
      ...baseDeps(),
      loadMessageAttachments: () => [{ type: 'photo' }],
      getMessageResource,
    });
    await expect(platform.downloadMessageMedia!(CHAT, MESSAGE, 0))
      .rejects.toThrow('missing its fileKey');
    expect(getMessageResource).not.toHaveBeenCalled();
  });
});
