import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { FeishuApiError } from './api';
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

  it('knows participants seen in-process and falls back to projected history', async () => {
    const fetchName = vi.fn(async (): Promise<string | undefined> => undefined);
    const names = createFeishuUserNames({
      fetchName,
      fallbackName: (_chatId, openId) => openId === 'ou_old' ? 'Old Name' : undefined,
      logger,
    });
    expect(names.isKnown('oc_chat', 'ou_nobody')).toBe(false);

    names.remember('ou_mentioned', 'Mentioned');
    expect(names.isKnown('oc_chat', 'ou_mentioned')).toBe(true);
    names.remember('ou_nameless', undefined);
    expect(names.isKnown('oc_chat', 'ou_nameless')).toBe(true);

    expect(names.isKnown('oc_chat', 'ou_old')).toBe(true);
    expect(names.isKnown('oc_other', 'ou_old')).toBe(true);

    await names.resolve('oc_chat', 'ou_sender');
    expect(names.isKnown('oc_chat', 'ou_sender')).toBe(true);
  });
  describe('chat member list fallback', () => {
    const denied = async (): Promise<string | undefined> => {
      throw new Error('code=41050');
    };

    it('names a sender the contact API cannot see, from one cached member-list fetch', async () => {
      const fetchChatMemberNames = vi.fn(async () => new Map([['ou_liu', '刘宇泽'], ['ou_lu', '鹿饮']]));
      const names = createFeishuUserNames({ fetchName: denied, fetchChatMemberNames, logger });
      expect(await names.resolve('oc_chat', 'ou_liu')).toBe('刘宇泽');
      expect(await names.resolve('oc_chat', 'ou_lu')).toBe('鹿饮');
      expect(fetchChatMemberNames).toHaveBeenCalledTimes(1);
    });

    it('treats an out-of-contact-range miss (41050) as settled for the refresh window', async () => {
      let clock = 0;
      const fetchName = vi.fn(async (): Promise<string | undefined> => {
        throw new FeishuApiError('contact.user.get', { code: 41050, httpStatus: 400 });
      });
      const fetchChatMemberNames = vi.fn(async () => new Map([['ou_ext', 'Ext']]));
      const names = createFeishuUserNames({
        fetchName, fetchChatMemberNames, logger, now: () => clock, refreshMs: 10_000, failureBackoffMs: 100,
      });
      expect(await names.resolve('oc_chat', 'ou_ext')).toBe('Ext');
      clock = 5_000;
      expect(await names.resolve('oc_chat', 'ou_ext')).toBe('Ext');
      expect(fetchName).toHaveBeenCalledTimes(1);
      clock = 10_001;
      await names.resolve('oc_chat', 'ou_ext');
      expect(fetchName).toHaveBeenCalledTimes(2);
    });

    it('retries other contact failures after the shorter failure backoff', async () => {
      let clock = 0;
      const fetchName = vi.fn(async (): Promise<string | undefined> => {
        throw new FeishuApiError('contact.user.get', { httpStatus: 503 });
      });
      const names = createFeishuUserNames({ fetchName, logger, now: () => clock, refreshMs: 10_000, failureBackoffMs: 100 });
      await names.resolve('oc_chat', 'ou_x');
      clock = 101;
      await names.resolve('oc_chat', 'ou_x');
      expect(fetchName).toHaveBeenCalledTimes(2);
    });

    it('does not fetch the member list when the contact API has the name', async () => {
      const fetchChatMemberNames = vi.fn(async () => new Map<string, string>());
      const names = createFeishuUserNames({ fetchName: async () => 'Alice', fetchChatMemberNames, logger });
      expect(await names.resolve('oc_chat', 'ou_alice')).toBe('Alice');
      expect(fetchChatMemberNames).not.toHaveBeenCalled();
    });

    it('refetches for an unlisted sender only after the miss backoff', async () => {
      let clock = 0;
      let members = new Map([['ou_old', 'Old']]);
      const fetchChatMemberNames = vi.fn(async () => members);
      const names = createFeishuUserNames({
        fetchName: denied, fetchChatMemberNames, logger, now: () => clock, memberMissBackoffMs: 100, failureBackoffMs: 1000,
      });
      expect(await names.resolve('oc_chat', 'ou_new')).toBe('');
      clock = 50;
      expect(await names.resolve('oc_chat', 'ou_new')).toBe('');
      expect(fetchChatMemberNames).toHaveBeenCalledTimes(1);
      members = new Map([['ou_old', 'Old'], ['ou_new', 'New']]);
      clock = 2000;
      expect(await names.resolve('oc_chat', 'ou_new')).toBe('New');
      expect(fetchChatMemberNames).toHaveBeenCalledTimes(2);
    });

    it('keeps chats separate and degrades to empty when the member list fails', async () => {
      const fetchChatMemberNames = vi.fn(async (chatId: string) => {
        if (chatId === 'oc_b') throw new Error('code=232011');
        return new Map([['ou_x', 'X in A']]);
      });
      const names = createFeishuUserNames({ fetchName: denied, fetchChatMemberNames, logger });
      expect(await names.resolve('oc_a', 'ou_x')).toBe('X in A');
      expect(await names.resolve('oc_b', 'ou_y')).toBe('');
      expect(fetchChatMemberNames).toHaveBeenCalledTimes(2);
    });

    it('bounds the wait for a slow member list and uses the result next time', async () => {
      let finish: (names: Map<string, string>) => void = () => {};
      const fetchChatMemberNames = vi.fn(() => new Promise<Map<string, string>>(resolve => {
        finish = resolve;
      }));
      const names = createFeishuUserNames({ fetchName: denied, fetchChatMemberNames, logger, lookupTimeoutMs: 10 });
      expect(await names.resolve('oc_chat', 'ou_slow')).toBe('');
      finish(new Map([['ou_slow', 'Slow']]));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(await names.resolve('oc_chat', 'ou_slow')).toBe('Slow');
      expect(fetchChatMemberNames).toHaveBeenCalledTimes(1);
    });
  });
});
