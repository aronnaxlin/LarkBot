import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { DEFAULT_PROBE_TIMEOUT_MS } from './turn-budget';
import { DEFAULT_TURN_BUDGET } from './turn-loop';
import type { ResolvedChatConfig } from './types';
import { executeWakeup } from './wakeup';
import { callLlm } from '../llm/call';
import type { MemorySnapshot } from '../memory/injection';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);

const chatConfig: ResolvedChatConfig = {
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-primary', apiFormat: 'openai-chat' },
    turnBudget: DEFAULT_TURN_BUDGET,
    reasoningReplayTurns: 3,
  },
  systemFiles: [],
  sendTypingAction: false,
  blockedUserIds: [],
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-probe', apiFormat: 'openai-chat' },
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    contextEstTokens: 20000,
    summaryMaxEstTokens: 20000,
  },
  participation: { style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' },
  memory: DEFAULT_MEMORY_CONFIG,
  imageToText: { enabled: false, maxConcurrency: 1 },
  animationToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  customEmojiToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  tools: { banSpammer: false, bash: { enabled: false, backgroundThresholdSec: 10, requireMaintainer: true, maintainerWindowSec: 600 } },
};

const rc: RenderedContext = [
  { receivedAtMs: 1000, senderId: 'user1', content: [{ type: 'text', text: '<message id="1" sender="Alice" t="01-01 00:00:01">@bot hi</message>' }], mentionsMe: true },
];

const snapshot: MemorySnapshot = {
  primaryXml: '## Your notes about this group\n\n<memory-self>\n- [2026-10-18] 群里叫我桃子\n</memory-self>\n<memory-person uid="user1" name="Alice" current="true">\n- [2026-10-19] 潮汕人\n</memory-person>',
  probeXml: '## The chatbot\'s own notes\n\n<memory-self>\n- [2026-10-18] 群里叫我桃子\n</memory-self>',
};

const textOf = (entries: ConversationEntry[]): string[] =>
  entries.flatMap(entry =>
    entry.kind === 'message' && entry.role === 'user'
      ? [entry.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')]
      : []);

interface Captured {
  probeEntries: ConversationEntry[];
  probeSystem: string;
  primaryEntries: ConversationEntry[];
  primarySystem: string;
  snapshotCalls: RenderedContext[];
}

const wake = async (options: { memoryEnabled?: boolean; snapshot?: MemorySnapshot | null; withLoader?: boolean; interrupted?: boolean } = {}): Promise<Captured> => {
  const captured: Captured = { probeEntries: [], probeSystem: '', primaryEntries: [], primarySystem: '', snapshotCalls: [] };
  vi.mocked(callLlm).mockImplementation(async (_config, entries, system) => {
    captured.probeEntries = entries;
    captured.probeSystem = system;
    return {
      entries: [{ kind: 'message', role: 'assistant', reasoning: undefined, parts: [{ kind: 'toolCall', callId: 'p1', name: 'decide', args: JSON.stringify({ should_act: 'send_message', reason: 'asked' }) }] }],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  });
  await executeWakeup({
    chatId: 'chat',
    chatConfig,
    currentChannel: 'telegram',
    contextAtStart: rc,
    currentContext: () => rc,
    loadTurnResponses: async () => [],
    persistTurnResponse: async () => {},
    persistProbeResponse: async () => {},
    getChatTitle: () => 'Test',
    getActiveBackgroundTasks: () => [],
    sendTypingAction: async () => {},
    createTools: () => [],
    runner: {
      runStepLoop: vi.fn(async (loop: { entries: ConversationEntry[]; system: string }) => {
        captured.primaryEntries = loop.entries;
        captured.primarySystem = loop.system;
      }) as never,
    },
    getLastProcessedMs: () => 0,
    setLastProcessedMs: () => {},
    isMaintainer: () => false,
    ...(options.memoryEnabled !== undefined ? { memoryEnabled: options.memoryEnabled } : {}),
    ...(options.withLoader === false ? {} : {
      loadMemorySnapshot: (context: RenderedContext) => {
        captured.snapshotCalls.push(context);
        return options.snapshot === undefined ? snapshot : options.snapshot;
      },
    }),
    log: useLogger('memory-wakeup-test'),
  });
  return captured;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
  vi.mocked(callLlm).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('person memory in the wake-up prompts', () => {
  it('leaves every prompt byte-identical when memory is off or yields nothing', async () => {
    const baseline = await wake({ withLoader: false });
    for (const variant of [await wake({ snapshot: null }), await wake({ memoryEnabled: false, snapshot: null })]) {
      expect(variant.probeSystem).toBe(baseline.probeSystem);
      expect(variant.primarySystem).toBe(baseline.primarySystem);
      expect(textOf(variant.probeEntries)).toEqual(textOf(baseline.probeEntries));
      expect(textOf(variant.primaryEntries)).toEqual(textOf(baseline.primaryEntries));
    }
    expect(baseline.primarySystem).not.toContain('Your notes');
    expect(textOf(baseline.primaryEntries).join('\n')).not.toContain('memory-');
  });

  it('puts the block once in the final user entry and keeps the cached prefix untouched', async () => {
    const baseline = await wake({ withLoader: false });
    const withMemory = await wake({ memoryEnabled: true });
    const primaryTexts = textOf(withMemory.primaryEntries);
    const last = primaryTexts.at(-1)!;
    expect(last).toContain(snapshot.primaryXml);
    expect(primaryTexts.join('\n').split('<memory-person').length - 1).toBe(1);
    expect(last.startsWith(textOf(baseline.primaryEntries).at(-1)!)).toBe(true);
    // everything before the late-binding entry is exactly what it was without memory
    expect(withMemory.primaryEntries.slice(0, -1)).toEqual(baseline.primaryEntries.slice(0, -1));
    expect(withMemory.probeEntries.slice(0, -1)).toEqual(baseline.probeEntries.slice(0, -1));
  });

  it('gives the probe SELF.md only, never a person card', async () => {
    const withMemory = await wake({ memoryEnabled: true });
    const probeText = textOf(withMemory.probeEntries).join('\n');
    expect(probeText).toContain('<memory-self>');
    expect(probeText).not.toContain('<memory-person');
    expect(probeText).not.toContain('潮汕人');
    expect(withMemory.probeSystem).not.toContain('Your notes');
  });

  it('adds the recall-and-forget guidance to the primary system prompt only when notes are injected', async () => {
    expect((await wake({ memoryEnabled: true })).primarySystem).toContain('**Your notes:**');
    expect((await wake({ memoryEnabled: false })).primarySystem).not.toContain('**Your notes:**');
    expect((await wake({ memoryEnabled: true })).probeSystem).not.toContain('**Your notes:**');
  });

  it('reads the snapshot once per wake-up, from the context the wake-up started with', async () => {
    const result = await wake({ memoryEnabled: true });
    expect(result.snapshotCalls).toEqual([rc]);
    expect(result.snapshotCalls[0]).toBe(rc);
  });
});
