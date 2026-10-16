import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { createFeishuUserNames } from './user-names';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('feishu-user-names-test');

describe('createFeishuUserNames', () => {
  it('caches contact names and refreshes only after the refresh window', async () => {
    let clock = 0;
    const fetchName = vi.fn(async () => 'Alice');
    const names = createFeishuUserNames({ fetchName, logger, now: () => clock, refreshMs: 100 });
    expect(await names.resolve('oc_chat', 'ou_alice')).toBe('Alice');
    expect(await names.resolve('oc_chat', 'ou_alice')).toBe('Alice');
    expect(fetchName).toHaveBeenCalledTimes(1);
    clock = 200;
    await names.resolve('oc_chat', 'ou_alice');
    expect(fetchName).toHaveBeenCalledTimes(2);
  });

  it('soft-degrades to the last known name, then projected history, then empty', async () => {
    const fetchName = vi.fn(async (): Promise<string | undefined> => {
      throw new Error('permission denied');
    });
    const names = createFeishuUserNames({
      fetchName,
      fallbackName: (_chatId, openId) => openId === 'ou_old' ? 'Old Name' : undefined,
      logger,
    });
    names.remember('ou_mentioned', 'Mentioned');
    expect(await names.resolve('oc_chat', 'ou_mentioned')).toBe('Mentioned');
    expect(await names.resolve('oc_chat', 'ou_old')).toBe('Old Name');
    expect(await names.resolve('oc_chat', 'ou_unknown')).toBe('');
  });

  it('bounds the wait for a slow lookup and keeps the result for later', async () => {
    let finish: (name: string) => void = () => {};
    const fetchName = vi.fn(() => new Promise<string>(resolve => {
      finish = resolve;
    }));
    const names = createFeishuUserNames({ fetchName, logger, lookupTimeoutMs: 5 });
    expect(await names.resolve('oc_chat', 'ou_slow')).toBe('');
    finish('Slow');
    await vi.waitFor(async () => expect(await names.resolve('oc_chat', 'ou_slow')).toBe('Slow'));
    expect(fetchName).toHaveBeenCalledTimes(1);
  });
});
