import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm/call', () => ({ callLlm: vi.fn() }));

import { registerMemory } from './memory';
import type { Config, ResolvedChatConfig } from '../../config/config';
import { createDatabase, persistEvent, runMigrations } from '../../db';
import type { DB } from '../../db';
import type { CompactionSessionMeta } from '../../driver/types';
import { callLlm } from '../../llm/call';
import { createChatMemory } from '../../memory/chat-memory';
import { alias, CHAT, del, msg, user } from '../../memory/test-support';
import { DEFAULT_MEMORY_CONFIG } from '../../memory/types';
import type { RenderParams } from '../../rendering';
import type { RenderedContext } from '../../rendering/types';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';
import type { Token } from '../tokens';

initLogger(LogLevel.Error, Format.Pretty);

const BOT = 'ou_bot';
const A = user('ou_a', '阿龙');
const B = user('ou_b', '小明');
const T = Date.UTC(2026, 9, 20, 12);

let directory: string;
let db: DB;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-registrar-'));
  db = createDatabase(join(directory, 'test.db'), useLogger('memory-registrar-test'));
  runMigrations(db, useLogger('memory-registrar-test'));
});
afterEach(() => {
  db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

const resolveDeps = (renderParams: RenderParams = { botUserId: BOT, aliasMessageIds: true }) => {
  const values = new Map<symbol, unknown>([
    [TOKENS.CONFIG.symbol, { memoryDir: join(directory, 'memory') } as Config],
    [TOKENS.LOGGER.symbol, useLogger('memory-registrar-test')],
    [TOKENS.DB.symbol, db],
    [TOKENS.PIPELINE.symbol, { getRenderParams: () => renderParams }],
    [TOKENS.PLATFORM_IDENTITY.symbol, { botUserId: () => BOT }],
  ]);
  const factories = new Map<symbol, () => unknown>();
  const registrar: Registrar = {
    get: <T>(token: Token<T>): T => {
      if (!values.has(token.symbol)) values.set(token.symbol, factories.get(token.symbol)!());
      return values.get(token.symbol) as T;
    },
    register: (token, factory) => { factories.set(token.symbol, factory); },
  };
  registerMemory(registrar);
  return registrar.get(TOKENS.MEMORY_DEPS);
};

const seed = () => {
  for (let index = 1; index <= 6; index++)
    persistEvent(db, msg({ id: `om_${index}`, sender: index % 2 ? A : B, at: T + index * 1_000 }));
  persistEvent(db, msg({ id: 'om_bot', sender: user(BOT, '莱克', true), at: T + 7_000, selfSent: true }));
  persistEvent(db, del(['om_2'], T + 8_000));
};

describe('memory registrar', () => {
  it('keeps the cursor in the database', () => {
    const deps = resolveDeps();
    expect(deps.loadCursor(CHAT)).toBe(0);
    deps.advanceCursor(CHAT, 123, null);
    expect(deps.loadCursor(CHAT)).toBe(123);
    deps.recordError(CHAT, 'boom');
    expect(deps.loadCursor(CHAT)).toBe(123);
  });

  it('counts human messages with the bot\'s id and the chat\'s blocklist', () => {
    seed();
    const deps = resolveDeps();
    expect(deps.countHumanMessagesSince(CHAT, 0, [])).toBe(6);
    expect(deps.countHumanMessagesSince(CHAT, 0, ['ou_b'])).toBe(3);
  });

  it('builds the window from the memory cursor over the archive, with the live chatlog formatting', () => {
    seed();
    const deps = resolveDeps();
    const window = deps.buildWindow(CHAT, 0, new Set(), 200);
    expect(window.truncated).toBe(false);
    expect(window.humanMessageCount).toBe(5);
    expect(window.endMs).toBe(T + 8_000);
    expect(window.xml).toContain(`<message id="${alias('om_1')}"`);
    expect(window.messages.get('om_2')?.deleted).toBe(true);
    expect(window.speakers.map(speaker => speaker.uid)).toEqual(['ou_a', 'ou_b']);
  });

  it('reads only the newest messages when more are waiting than the window allows', () => {
    seed();
    const deps = resolveDeps();
    const window = deps.buildWindow(CHAT, 0, new Set(), 3);
    expect(window.truncated).toBe(true);
    expect(window.xml).not.toContain(alias('om_1'));
    expect(window.xml).toContain(alias('om_4'));
    expect(window.xml).toContain(alias('om_6'));
    // the cursor is the lower bound: nothing before it is read either way
    const later = deps.buildWindow(CHAT, T + 5_000, new Set(), 200);
    expect(later.truncated).toBe(false);
    expect(later.xml).not.toContain(alias('om_4'));
    expect(later.xml).toContain(alias('om_5'));
  });

  it('resolves deletion for evidence outside any window, and calls unknown ids unknown', () => {
    seed();
    const deps = resolveDeps();
    const statuses = deps.resolveEvidence(CHAT, [alias('om_2'), alias('om_3'), 'om_2', 'mtypo0000001']);
    expect(Object.fromEntries(statuses)).toEqual({
      [alias('om_2')]: 'deleted',
      [alias('om_3')]: 'alive',
      om_2: 'deleted',
      mtypo0000001: 'unknown',
    });
    expect(deps.resolveEvidence(CHAT, []).size).toBe(0);
  });

  it('treats evidence as canonical ids on platforms that do not alias', () => {
    seed();
    const deps = resolveDeps({ botUserId: BOT });
    expect(Object.fromEntries(deps.resolveEvidence(CHAT, ['om_2', 'om_3', alias('om_3')]))).toEqual({
      om_2: 'deleted',
      om_3: 'alive',
      [alias('om_3')]: 'unknown',
    });
  });
});

describe('memory end to end', () => {
  it('turns persisted chat into cards and moves the cursor once enough messages have arrived', async () => {
    seed();
    const output = JSON.stringify({
      ops: [
        { path: 'people/ou_a.md', op: 'add', intent: 'add', text: '住在深圳', evidence: [alias('om_1')] },
        { path: 'people/ou_a.md', op: 'add', intent: 'add', text: '群里的说法：叫他龙哥', evidence: [alias('om_4')] },
      ],
    });
    vi.mocked(callLlm).mockResolvedValue({
      entries: [{ kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'text', text: output }] }],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const deps = resolveDeps();
    const context = signal<RenderedContext>([]);
    const chatConfig = {
      primary: { model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'primary-model', apiFormat: 'openai-chat' } },
      compaction: {},
      blockedUserIds: [],
      memory: { ...DEFAULT_MEMORY_CONFIG, enabled: true, triggerMessages: 5 },
    } as unknown as ResolvedChatConfig;
    const memory = createChatMemory({
      chatId: CHAT,
      chatConfig,
      deps,
      context,
      compactionMeta: signal<CompactionSessionMeta | null>(null),
      log: useLogger('memory-registrar-test'),
    });

    context([{ receivedAtMs: T, senderId: 'ou_a', content: [{ type: 'text', text: 'x' }] }]);
    await vi.waitFor(() => expect(deps.loadCursor(CHAT)).toBe(T + 8_000));

    expect(deps.backend.readCards(CHAT, ['ou_a'])[0]?.entries.map(entry => [entry.date, entry.text])).toEqual([
      ['2026-10-20', '住在深圳'],
      ['2026-10-20', '群里的说法：叫他龙哥'],
    ]);
    expect(deps.countHumanMessagesSince(CHAT, deps.loadCursor(CHAT), [])).toBe(0);
    memory.dispose();
  });
});
