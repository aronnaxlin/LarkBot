import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { createChatMemory } from './chat-memory';
import type { MemoryDeps } from './deps';
import { createMarkdownMemoryStore } from './store-md';
import { alias, CHAT, makeWindow } from './test-support';
import { DEFAULT_MEMORY_CONFIG } from './types';
import type { MemoryBackend } from './types';
import type { ResolvedChatConfig } from '../config/config';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../driver/turn-budget';
import { DEFAULT_TURN_BUDGET } from '../driver/turn-loop';
import type { CompactionSessionMeta } from '../driver/types';
import { callLlm } from '../llm/call';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);
const log = useLogger('chat-memory-test');

const configWith = (memory: Partial<typeof DEFAULT_MEMORY_CONFIG>, blockedUserIds: string[] = []): ResolvedChatConfig => ({
  primary: { model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'primary-model', apiFormat: 'openai-chat' }, turnBudget: DEFAULT_TURN_BUDGET, reasoningReplayTurns: 3 },
  systemFiles: [],
  sendTypingAction: false,
  blockedUserIds,
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: { model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'probe', apiFormat: 'openai-chat' }, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, contextEstTokens: 20000, summaryMaxEstTokens: 20000 },
  participation: { style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' },
  memory: { ...DEFAULT_MEMORY_CONFIG, ...memory },
  imageToText: { enabled: false, maxConcurrency: 1 },
  animationToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  customEmojiToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  plugins: {},
  tools: { banSpammer: false, bash: { enabled: false, backgroundThresholdSec: 10, requireMaintainer: true, maintainerWindowSec: 600 } },
});

let root: string;
let backend: MemoryBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-memory-'));
  backend = createMarkdownMemoryStore({ rootDir: root, logger: log });
  vi.mocked(callLlm).mockReset();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const depsWith = (overrides: Partial<MemoryDeps> = {}): MemoryDeps => ({
  backend,
  loadCursor: () => 0,
  advanceCursor: vi.fn(),
  recordError: vi.fn(),
  countHumanMessagesSince: vi.fn(() => 0),
  buildWindow: () => makeWindow([]),
  resolveEvidence: () => new Map(),
  ...overrides,
});

const make = (memory: Partial<typeof DEFAULT_MEMORY_CONFIG>, deps: MemoryDeps | undefined, blocked: string[] = []) => {
  const context = signal<RenderedContext>([]);
  return {
    context,
    memory: createChatMemory({
      chatId: CHAT,
      chatConfig: configWith(memory, blocked),
      deps,
      context,
      compactionMeta: signal<CompactionSessionMeta | null>(null),
      log,
    }),
  };
};

const speak = (senderId: string, extra: Record<string, unknown> = {}): RenderedContext[number] =>
  ({ receivedAtMs: 1, senderId, content: [{ type: 'text', text: 'x' }], ...extra });

const seed = () => backend.applyBatch(CHAT, [
  { path: 'SELF.md', baseHash: null, next: { header: '# SELF', entries: [{ date: '2026-10-18', evidence: [alias('om_1')], text: '群里叫我桃子' }] }, records: [], forgets: [] },
  { path: 'people/ou_a.md', baseHash: null, next: { header: '# 阿龙 (ou_a)', entries: [{ date: '2026-10-19', evidence: [alias('om_2')], text: '潮汕人' }] }, records: [], forgets: [] },
  { path: 'people/ou_blocked.md', baseHash: null, next: { header: '# 屏蔽 (ou_blocked)', entries: [{ date: '2026-10-19', evidence: [alias('om_3')], text: '不该出现' }] }, records: [], forgets: [] },
], { doNotReadd: 20 });

describe('createChatMemory', () => {
  it('does nothing without deps or when memory is disabled for the chat', () => {
    for (const memory of [make({ enabled: true }, undefined).memory, make({ enabled: false }, depsWith()).memory]) {
      expect(memory.injecting).toBe(false);
      expect(memory.loadSnapshot).toBeUndefined();
      expect(() => memory.dispose()).not.toThrow();
    }
  });

  it('writes but does not inject in shadow mode', () => {
    const deps = depsWith({ countHumanMessagesSince: vi.fn(() => 0) });
    const { memory, context } = make({ enabled: true, inject: false }, deps);
    expect(memory.injecting).toBe(false);
    expect(memory.loadSnapshot).toBeUndefined();
    context([speak('ou_a')]);
    memory.dispose();
  });

  it('reads SELF.md and the recent speakers\' cards, never a blocked one', () => {
    seed();
    const { memory } = make({ enabled: true, inject: true }, depsWith(), ['ou_blocked']);
    expect(memory.injecting).toBe(true);
    const snapshot = memory.loadSnapshot!([speak('ou_blocked'), speak('ou_a'), speak('ou_bot', { isMyself: true })]);
    expect(snapshot?.primaryXml).toContain('群里叫我桃子');
    expect(snapshot?.primaryXml).toContain('<memory-person uid="ou_a" name="阿龙" current="true">');
    expect(snapshot?.primaryXml).not.toContain('不该出现');
    expect(snapshot?.probeXml).not.toContain('潮汕人');
    memory.dispose();
  });

  it('returns nothing for empty memory', () => {
    const { memory } = make({ enabled: true }, depsWith());
    expect(memory.loadSnapshot!([speak('ou_a')])).toBeNull();
    memory.dispose();
  });

  it('degrades to no notes when the memory directory cannot be read, instead of failing the wake-up', () => {
    const broken: MemoryBackend = { ...backend, readSelf: () => { throw new Error('EACCES'); } };
    const { memory } = make({ enabled: true }, depsWith({ backend: broken }));
    expect(memory.loadSnapshot!([speak('ou_a')])).toBeNull();
    memory.dispose();
  });
});
