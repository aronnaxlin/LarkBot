import { describe, expect, it } from 'vitest';

import { composeContext, findWorkingWindowCursor } from './context';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry, InputPart, ToolResult } from '../unified-api/types';

const CURRENT_MODEL = 'test-model';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, entries: ConversationEntry[], modelName = CURRENT_MODEL): TurnResponseV2 => ({
  requestedAtMs: ts,
  entries,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelName,
});

const assistantText = (text: string): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text }],
  reasoning: undefined,
});

const assistantToolCall = (callId: string, name = 'read'): ConversationEntry => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId, name, args: '{}' }],
  reasoning: undefined,
});

const toolResult = (callId: string, payload: string | InputPart[]): ToolResult => ({
  kind: 'toolResult',
  callId,
  payload,
  requiresFollowUp: true,
});

const longText = (label: string): string => `${label}:${'x'.repeat(1000)}`;

const getToolResults = (entries: ConversationEntry[]): ToolResult[] =>
  entries.filter((e): e is ToolResult => e.kind === 'toolResult');

const hasLoneSurrogate = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      i++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
};

describe('composeContext — trimToolResults', () => {
  it('keeps only the last 5 oversized tool results untrimmed', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 7 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    expect(tres).toHaveLength(7);
    expect(tres[0]!.payload).toMatch(/\[trimmed/);
    expect(tres[1]!.payload).toMatch(/\[trimmed/);
    for (let i = 2; i < 7; i++) expect(tres[i]!.payload).toBe(contents[i]);
  });

  it('does nothing when there are exactly 5 oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const contents = Array.from({ length: 5 }, (_, i) => longText(`r${i + 1}`));
    const trs = contents.map((c, i) =>
      tr(200 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, c)]));

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const tres = getToolResults(result!.entries);
    for (let i = 0; i < 5; i++) expect(tres[i]!.payload).toBe(contents[i]);
  });

  it('trimmed content preserves head and tail', () => {
    const content = `HEAD${'x'.repeat(800)}TAIL`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [assistantToolCall('tc0'), toolResult('tc0', content)]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const trimmed = getToolResults(result!.entries)[0]!.payload as string;
    expect(trimmed).toContain('HEAD');
    expect(trimmed).toContain('TAIL');
    expect(trimmed).toContain('[trimmed');
  });

  it('does not split surrogate pairs at either trim boundary', () => {
    const content = `${'x'.repeat(199)}😀${'y'.repeat(400)}😀${'z'.repeat(199)}`;
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [assistantToolCall('tc0'), toolResult('tc0', content)]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const trimmed = getToolResults(result!.entries)[0]!.payload as string;
    expect(hasLoneSurrogate(trimmed)).toBe(false);
  });

  it('preserves assistant entries when trimming older oversized tool results', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs: TurnResponseV2[] = [
      tr(200, [
        assistantToolCall('tc0'),
        toolResult('tc0', longText('oldest')),
        assistantText('I read the file'),
      ]),
      ...Array.from({ length: 5 }, (_, i) =>
        tr(300 + i * 100, [assistantToolCall(`tc${i + 1}`), toolResult(`tc${i + 1}`, longText(`r${i + 1}`))])),
    ];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const entries = result!.entries;
    const tres = getToolResults(entries);
    expect(tres[0]!.payload).toMatch(/\[trimmed/);
    const hasAssistantText = entries.some(e =>
      e.kind === 'message' && e.role === 'assistant'
      && e.parts.some(p => p.kind === 'text' && p.text === 'I read the file'));
    expect(hasAssistantText).toBe(true);
  });
});

describe('composeContext — reasoning strip on model mismatch', () => {
  const reasoningEntry: ConversationEntry = {
    kind: 'message',
    role: 'assistant',
    parts: [
      { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: 'hmm', signature: 'sig' } } },
      { kind: 'text', text: 'answer' },
    ],
    reasoning: undefined,
  };

  it('preserves reasoning when modelName matches current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], CURRENT_MODEL)];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant');
    expect(assistant).toBeDefined();
    const hasReasoning = (assistant as { parts: { kind: string }[] }).parts
      .some(p => p.kind === 'reasoning');
    expect(hasReasoning).toBe(true);
  });

  it('strips reasoning when modelName differs from current model', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [tr(200, [reasoningEntry], 'other-model')];

    const result = composeContext(rc, trs, 100_000, CURRENT_MODEL);
    const assistant = result!.entries.find(e => e.kind === 'message' && e.role === 'assistant');
    expect(assistant).toBeDefined();
    const hasReasoning = (assistant as { parts: { kind: string }[] }).parts
      .some(p => p.kind === 'reasoning');
    expect(hasReasoning).toBe(false);
  });
});

describe('composeContext — misc', () => {
  it('returns null when rc + trs + summary are all empty', () => {
    expect(composeContext([], [], 100_000, CURRENT_MODEL)).toBeNull();
  });

  it('prepends compact summary as first user message', () => {
    const result = composeContext([textSeg(100, 'hi')], [], 100_000, CURRENT_MODEL, 'earlier stuff');
    expect(result).not.toBeNull();
    const first = result!.entries[0]!;
    expect(first.kind).toBe('message');
    expect(first.kind === 'message' && first.role === 'user').toBe(true);
    const firstText = first.kind === 'message' && first.role === 'user'
      && first.parts[0]!.kind === 'text' ? first.parts[0]!.text : '';
    expect(firstText).toContain('Conversation summary');
    expect(firstText).toContain('earlier stuff');
  });
});

describe('findWorkingWindowCursor', () => {
  // Tokens ≈ ceil(text.length / 2), so 2 chars ≈ 1 token.
  const textOfTokens = (tokens: number): string => 'x'.repeat(tokens * 2);

  it('excludes the entry that overflows the budget so the cursor advances past it', () => {
    // Regression: the caller retains entries with `receivedAtMs >= cursor`, so
    // returning the overflowing entry's own timestamp pinned the cursor
    // (newCursorMs === oldCursorMs) and every later compaction window was empty.
    const oldCursorMs = 100;
    const rc = [
      textSeg(300, textOfTokens(50)),
      textSeg(200, textOfTokens(50)),
      textSeg(100, textOfTokens(5000)), // huge boundary entry, same time as cursor
    ];
    const cursor = findWorkingWindowCursor(rc, [], 200);
    expect(cursor).toBeGreaterThan(oldCursorMs);
    // The overflowing entry is dropped: only the two 50-token segments remain.
    const retained = rc.filter(seg => seg.receivedAtMs >= cursor);
    expect(retained.map(seg => seg.receivedAtMs)).toEqual([300, 200]);
  });

  it('returns the oldest timestamp when everything fits within the budget', () => {
    const rc = [
      textSeg(300, textOfTokens(50)),
      textSeg(200, textOfTokens(50)),
    ];
    expect(findWorkingWindowCursor(rc, [], 1000)).toBe(200);
  });

  it('strictly advances even when the single newest entry overflows alone', () => {
    const rc = [textSeg(500, textOfTokens(5000))];
    expect(findWorkingWindowCursor(rc, [], 200)).toBe(501);
  });

  it('counts turn responses on the same timeline as rendered segments', () => {
    const rc = [textSeg(300, textOfTokens(50))];
    const trs = [tr(100, [assistantText(textOfTokens(5000))])];
    const cursor = findWorkingWindowCursor(rc, trs, 200);
    expect(cursor).toBe(101);
    expect(rc.filter(seg => seg.receivedAtMs >= cursor).length).toBe(1);
  });
});
