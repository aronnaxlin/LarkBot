import { describe, expect, it, vi } from 'vitest';

import type { TelegramDriverHooks } from './driver-hooks';
import { createTelegramDriverPlatform } from './driver-platform';

// The Driver now speaks string message ids; Telegram behavior must stay the
// same, with numeric conversion confined to this adapter.
const fixture = () => {
  const hooks = {
    sendMessage: vi.fn(async () => ({ messageId: 42, date: 1, text: 'hi' })),
    setMessageReaction: vi.fn(async () => {}),
    sendTypingAction: vi.fn(async () => {}),
    onDebounceStateChange: vi.fn(),
    downloadMessageMedia: vi.fn(async () => Buffer.from('file')),
  };
  const deps = {
    hooks: hooks as unknown as TelegramDriverHooks,
    messageExists: vi.fn((_chatId: string, messageId: number) => messageId === 7),
    loadMessageAttachments: vi.fn(() => [{ type: 'photo' as const }]),
    banSpammer: vi.fn(async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const })),
  };
  return { hooks, deps, platform: createTelegramDriverPlatform(deps) };
};

describe('createTelegramDriverPlatform', () => {
  it('converts string ids to Telegram numbers at the edge and returns string ids', async () => {
    const { hooks, deps, platform } = fixture();
    expect(platform.name).toBe('telegram');
    // Telegram keeps advertising outbound send_message attachments.
    expect(platform.supportsOutboundAttachments).toBe(true);
    await expect(platform.sendMessage('-100', 'hi', '7')).resolves.toEqual({ messageId: '42' });
    expect(hooks.sendMessage).toHaveBeenCalledWith('-100', 'hi', 7, undefined);
    await platform.setMessageReaction('-100', '7', '👍');
    expect(hooks.setMessageReaction).toHaveBeenCalledWith('-100', 7, '👍');
    await platform.downloadMessageMedia!('-100', '7', 0);
    expect(hooks.downloadMessageMedia).toHaveBeenCalledWith('-100', 7);
    expect(platform.loadMessageAttachments!('-100', '7')).toEqual([{ type: 'photo' }]);
    await platform.banSpammer!('-100', '7');
    expect(deps.banSpammer).toHaveBeenCalledWith('-100', 7);
  });

  it('never lets non-numeric ids reach TDLib', async () => {
    const { hooks, deps, platform } = fixture();
    expect(platform.messageExists('-100', '7')).toBe(true);
    for (const id of ['om_x', '0', '-1', '1.5', '99999999999999999'])
      expect(platform.messageExists('-100', id)).toBe(false);
    expect(deps.messageExists).toHaveBeenCalledTimes(1);
    expect(platform.loadMessageAttachments!('-100', 'om_x')).toBeUndefined();
    await expect(platform.downloadMessageMedia!('-100', '7', 1)).rejects.toThrow('index 1 is not addressable');
    await expect(platform.sendMessage('-100', 'hi', 'om_x')).rejects.toThrow('Invalid Telegram message id');
    await expect(platform.setMessageReaction('-100', 'om_x', '👍')).rejects.toThrow('Invalid Telegram message id');
    expect(hooks.sendMessage).not.toHaveBeenCalled();
    expect(hooks.setMessageReaction).not.toHaveBeenCalled();
  });
});
