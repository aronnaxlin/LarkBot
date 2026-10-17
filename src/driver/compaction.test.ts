import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { runCompaction } from './compaction';
import { callLlm } from '../llm/call';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);

const entryText = (entries: ConversationEntry[]): string =>
  entries.flatMap(e =>
    e.kind === 'message' ? e.parts.flatMap(p => p.kind === 'text' ? [p.text] : []) : []).join('\n');

describe('runCompaction', () => {
  beforeEach(() => vi.mocked(callLlm).mockReset());

  it('accumulates usage from empty-summary retries', async () => {
    vi.mocked(callLlm)
      .mockResolvedValueOnce({
        entries: [],
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      })
      .mockResolvedValueOnce({
        entries: [{
          kind: 'message',
          role: 'assistant',
          parts: [{ kind: 'text', text: 'summary' }],
          reasoning: undefined,
        }],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      });

    const result = await runCompaction({
      apiBaseUrl: 'mock',
      apiKey: 'key',
      model: 'model',
      apiFormat: 'openai-chat',
      chatId: 'chat',
      rcWindow: [{ receivedAtMs: 1, content: [{ type: 'text', text: 'history' }] }],
      trsWindow: [],
      oldCursorMs: 0,
      newCursorMs: 1,
      maxContextEstTokens: 200_000,
      reasoningReplayTurns: 3,
      log: useLogger('compaction-test'),
    });

    expect(result).toMatchObject({
      summary: 'summary',
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
  });

  it('keeps the existing summary intact when the compaction window overflows the cap', async () => {
    vi.mocked(callLlm).mockResolvedValueOnce({
      entries: [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'new summary' }],
        reasoning: undefined,
      }],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const existingSummary = `OLD-${'s'.repeat(500)}`;
    const rcWindow = Array.from({ length: 3 }, (_, i) => ({
      receivedAtMs: i,
      content: [{ type: 'text' as const, text: `window ${i}:${'x'.repeat(20_000)}` }],
    }));

    await runCompaction({
      apiBaseUrl: 'mock',
      apiKey: 'key',
      model: 'model',
      apiFormat: 'openai-chat',
      chatId: 'chat',
      rcWindow,
      trsWindow: [],
      existingSummary,
      oldCursorMs: 0,
      newCursorMs: 3,
      // Cap = trigger + headroom (~20K), far below the 30K-token window, so the
      // raw window must be trimmed while the summary survives untouched.
      maxContextEstTokens: 100,
      reasoningReplayTurns: 3,
      log: useLogger('compaction-test'),
    });

    const sentEntries = vi.mocked(callLlm).mock.calls[0]![1];
    const first = sentEntries[0] as { parts: { kind: string; text?: string }[] };
    expect(first.parts[0]!.text).toContain(existingSummary);
    const text = entryText(sentEntries);
    expect(text).toContain('window 2');
    expect(text).not.toContain('window 0');
  });
});
