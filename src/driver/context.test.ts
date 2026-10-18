import { describe, expect, it } from 'vitest';

import { composeContext, composeProbeContext, findWorkingWindowCursor, lastActedAtMs, reasoningKeepFrom, selectProbeWindowStart } from './context';
import type { TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry, InputPart, OutputMessage, ToolResult } from '../unified-api/types';

const CURRENT_MODEL = 'test-model';

const textSeg = (ts: number, text: string): RenderedContext[number] => ({
  receivedAtMs: ts,
  content: [{ type: 'text', text }],
});

const tr = (ts: number, entries: ConversationEntry[], modelName = CURRENT_MODEL): TurnResponseV2 => ({
  requestedAtMs: ts,
  entries,
  shellToolsExposed: false,
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

const assistantReasoning = (text: string): OutputMessage => ({
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text: 'answer' }],
  reasoning: { reasoning_content: text },
});

const assistantThinkingPart = (text: string): OutputMessage => ({
  kind: 'message',
  role: 'assistant',
  parts: [
    { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: text } } },
    { kind: 'text', text: 'answer' },
  ],
  reasoning: undefined,
});

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

describe('composeContext — reasoning token accounting', () => {
  it('counts message-level reasoning instead of ignoring it', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const without: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }], reasoning: undefined,
    }];
    const base = composeContext(rc, [tr(200, without)], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    const counted = composeContext(rc, [tr(200, [assistantReasoning('x'.repeat(400))])], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    expect(counted - base).toBe(200); // 400 chars / 2 chars-per-token
  });

  it('counts reasoning parts instead of a flat approximation', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const short: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', reasoning: undefined,
      parts: [
        { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: '' } } },
        { kind: 'text', text: 'answer' },
      ],
    }];
    const shortTokens = composeContext(rc, [tr(200, short)], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    const longTokens = composeContext(rc, [tr(200, [assistantThinkingPart('y'.repeat(400))])], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    expect(longTokens - shortTokens).toBe(200);
  });
});

describe('reasoning replay recency', () => {
  const simpleReasoningTR = (ts: number): TurnResponseV2 => tr(ts, [
    { kind: 'message', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }], reasoning: { reasoning_content: `reasoning ${ts}` } },
  ]);

  const chainTR = (ts: number, callId: string, requiresFollowUp: boolean): TurnResponseV2 => tr(ts, [
    {
      kind: 'message', role: 'assistant', reasoning: { reasoning_content: `reasoning ${callId}` },
      parts: [{ kind: 'toolCall', callId, name: 'read', args: '{}' }],
    },
    { kind: 'toolResult', callId, payload: 'ok', requiresFollowUp },
  ]);

  const assistantReasoningFlags = (entries: ConversationEntry[]): boolean[] =>
    entries
      .filter((e): e is OutputMessage => e.kind === 'message' && e.role === 'assistant')
      .map(e => e.reasoning !== undefined || e.parts.some(p => p.kind === 'reasoning'));

  it('keeps reasoning only in the newest K turn responses', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [1, 2, 3, 4, 5].map(i => simpleReasoningTR(i * 100));
    const result = composeContext(rc, trs, 1_000_000, CURRENT_MODEL, undefined, 3);
    expect(assistantReasoningFlags(result!.entries)).toEqual([false, false, true, true, true]);
  });

  it('never strips the newest response (pending tool_result needs its thinking) even when K is 0', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const trs = [1, 2, 3].map(i => simpleReasoningTR(i * 100));
    const result = composeContext(rc, trs, 1_000_000, CURRENT_MODEL, undefined, 0);
    expect(assistantReasoningFlags(result!.entries)).toEqual([false, false, true]);
    expect(reasoningKeepFrom(trs, 0)).toBe(2);
  });

  it('keeps the whole current interrupted chain even beyond K', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    // TRs 3-5 form a chain: each of 3 and 4 requires follow-up.
    const trs = [
      simpleReasoningTR(100),
      simpleReasoningTR(200),
      chainTR(300, 'c3', true),
      chainTR(400, 'c4', true),
      chainTR(500, 'c5', false),
    ];
    const result = composeContext(rc, trs, 1_000_000, CURRENT_MODEL, undefined, 1);
    expect(assistantReasoningFlags(result!.entries)).toEqual([false, false, true, true, true]);
    expect(reasoningKeepFrom(trs, 1)).toBe(2);
    expect(reasoningKeepFrom(trs, 3)).toBe(2);
    expect(reasoningKeepFrom(trs, 10)).toBe(0);
  });
});

describe('selectProbeWindowStart', () => {
  const seg = (index: number, tokens = 100) => ({ receivedAtMs: (index + 1) * 1000, tokens });

  it('returns null for an empty context', () => {
    expect(selectProbeWindowStart({
      segments: [], maxEstTokens: 1000, lastActedMs: 0, previousStartMs: null,
    })).toBeNull();
  });

  it('bounds a fresh window to about half the budget', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i));
    const selection = selectProbeWindowStart({
      segments, maxEstTokens: 1000, lastActedMs: 10_000, previousStartMs: null,
    });
    // Newest suffix of 500 tokens = segments 5..9.
    expect(selection!.startMs).toBe(segments[5]!.receivedAtMs);
    const retained = segments.filter(s => s.receivedAtMs >= selection!.startMs);
    expect(retained).toHaveLength(5);
  });

  it('always includes everything since the bot last acted', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i));
    const selection = selectProbeWindowStart({
      segments, maxEstTokens: 1000, lastActedMs: 3500, previousStartMs: null,
    });
    // Target would cut at 6000, but messages after 3500 must stay: 4000.
    expect(selection!.startMs).toBe(4000);
    expect(segments.filter(s => s.receivedAtMs >= selection!.startMs)).toHaveLength(7);
  });

  it('keeps only the newest part when unprocessed input alone exceeds the budget', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i));
    const selection = selectProbeWindowStart({
      segments, maxEstTokens: 500, lastActedMs: 2500, previousStartMs: null,
    });
    // Mandatory 3000..10000 = 800 tokens > 500, so fall back to the ~250-token
    // newest suffix: segments 8..9.
    expect(selection!.overCap).toBe(true);
    expect(selection!.startMs).toBe(segments[8]!.receivedAtMs);
    expect(segments.filter(s => s.receivedAtMs >= selection!.startMs)).toHaveLength(2);
  });

  it('keeps the start fixed while the slice grows to the budget, then jumps', () => {
    const options = { maxEstTokens: 1000, lastActedMs: 10_000, previousStartMs: 1000 };
    expect(selectProbeWindowStart({ ...options, segments: Array.from({ length: 4 }, (_, i) => seg(i)) })!.startMs).toBe(1000);
    // 700 tokens: still inside the budget, start unchanged.
    expect(selectProbeWindowStart({ ...options, segments: Array.from({ length: 7 }, (_, i) => seg(i)) })!.startMs).toBe(1000);
    // Exactly the budget also stays.
    expect(selectProbeWindowStart({ ...options, segments: Array.from({ length: 10 }, (_, i) => seg(i)) })!.startMs).toBe(1000);
    // 1100 tokens: jump forward, retaining the ~500-token newest suffix.
    const grown = Array.from({ length: 11 }, (_, i) => seg(i));
    const jumped = selectProbeWindowStart({ ...options, segments: grown })!.startMs;
    expect(jumped).toBe(7000);
    expect(grown.filter(s => s.receivedAtMs >= jumped!).reduce((a, s) => a + s.tokens, 0)).toBe(500);
  });

  it('pins direct addresses beyond the over-cap fallback', () => {
    const mention = { receivedAtMs: 1000, tokens: 100, mentionsMe: true };
    const reply = { receivedAtMs: 1100, tokens: 100, repliesToMe: true };
    const chatter = Array.from({ length: 30 }, (_, i) => ({ receivedAtMs: 2000 + i * 1000, tokens: 100 }));
    const selection = selectProbeWindowStart({
      segments: [mention, reply, ...chatter], maxEstTokens: 1000, lastActedMs: 0, previousStartMs: null,
    })!;
    expect(selection.overCap).toBe(true);
    expect(selection.startMs).toBeGreaterThan(1100);
    expect(selection.pinnedReceivedAtMs).toEqual([1000, 1100]);
    // The unpinned chatter before the start is omitted.
    expect(selection.omittedCount).toBe(25);
  });

  it('holds the over-cap fallback start across wake-ups until the kept slice overflows', () => {
    const base = Array.from({ length: 30 }, (_, i) => ({ receivedAtMs: 2000 + i * 1000, tokens: 100 }));
    const first = selectProbeWindowStart({ segments: base, maxEstTokens: 1000, lastActedMs: 0, previousStartMs: null })!;
    const grown = [...base, { receivedAtMs: 32_000, tokens: 100 }, { receivedAtMs: 33_000, tokens: 100 }];
    const second = selectProbeWindowStart({ segments: grown, maxEstTokens: 1000, lastActedMs: 0, previousStartMs: first.startMs })!;
    expect(second.overCap).toBe(true);
    expect(second.startMs).toBe(first.startMs);
    const overflow = [...grown, ...Array.from({ length: 10 }, (_, i) => ({ receivedAtMs: 34_000 + i * 1000, tokens: 100 }))];
    const third = selectProbeWindowStart({ segments: overflow, maxEstTokens: 1000, lastActedMs: 0, previousStartMs: first.startMs })!;
    expect(third.startMs).toBeGreaterThan(first.startMs);
  });
});

describe('composeProbeContext — bounded probe window', () => {
  const bigSeg = (index: number): RenderedContext[number] => {
    const prefix = `message ${index}`;
    return textSeg((index + 1) * 1000, `${prefix}:${'x'.repeat(1000 - prefix.length - 1)}`); // exactly 500 est tokens
  };

  it('drops history outside the window but keeps everything since the last action', () => {
    const rc = Array.from({ length: 10 }, (_, i) => bigSeg(i));
    const result = composeProbeContext(rc, [], 1000, undefined, { lastActedMs: 8500, previousStartMs: null });
    expect(result!.windowStartMs).toBe(9000);
    const text = result!.entries.flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(text).toContain('message 9');
    expect(text).toContain('message 8');
    expect(text).not.toContain('message 7');
  });

  it('includes the summary without spending the chat slice budget', () => {
    const rc = Array.from({ length: 4 }, (_, i) => bigSeg(i)); // 2000 est tokens total
    const summary = 'old compacted history '.repeat(500); // ~10K est tokens
    const result = composeProbeContext(rc, [], 1000, summary, {
      lastActedMs: 2500,
      previousStartMs: null,
      summaryMaxEstTokens: 20_000,
    });
    const first = result!.entries[0] as { parts: { kind: string; text?: string }[] };
    expect(first.parts[0]!.text).toContain('old compacted history');
    expect(first.parts[0]!.text).not.toContain('truncated');
    // The chat slice still gets the full 1000-token budget: target ≈ 500 tokens.
    const chatText = result!.entries.slice(1)
      .flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(chatText).toContain('message 3');
    expect(chatText).toContain('message 2');
  });

  it('truncates an oversized summary from the end but never drops it', () => {
    const rc = Array.from({ length: 2 }, (_, i) => bigSeg(i));
    const summary = `HEAD${'s'.repeat(100_000)}TAIL`; // 50K est tokens
    const result = composeProbeContext(rc, [], 1000, summary, {
      lastActedMs: 0,
      previousStartMs: null,
      summaryMaxEstTokens: 20_000,
    });
    const firstEntry = result!.entries[0] as { parts: { text?: string }[] };
    const text = firstEntry.parts[0]!.text ?? '';
    expect(text).toContain('HEAD');
    expect(text).not.toContain('TAIL');
    expect(text).toContain('[... summary truncated ...]');
  });

  it('keeps working when a compaction cursor moved past the previous window start', () => {
    const rc = [bigSeg(5), bigSeg(6)];
    const result = composeProbeContext(rc, [], 1000, 'summary', { lastActedMs: 0, previousStartMs: 3000 });
    expect(result!.windowStartMs).toBe(3000);
    const text = result!.entries
      .flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(text).toContain('summary');
    expect(text).toContain('message 5');
    expect(text).toContain('message 6');
  });

  it('keeps the window start across calls until the slice overflows', () => {
    const rc = Array.from({ length: 6 }, (_, i) => bigSeg(i));
    const first = composeProbeContext(rc, [], 1000, undefined, { lastActedMs: 0, previousStartMs: null });
    const second = composeProbeContext(rc, [], 1000, undefined, { lastActedMs: 0, previousStartMs: first!.windowStartMs });
    expect(second!.windowStartMs).toBe(first!.windowStartMs);

    const grown = [...rc, bigSeg(6), bigSeg(7)];
    const third = composeProbeContext(grown, [], 1000, undefined, { lastActedMs: 0, previousStartMs: first!.windowStartMs });
    expect(third!.windowStartMs).toBe(grown[7]!.receivedAtMs);
  });

  it('keeps an over-cap direct address and marks the omitted gap inline', () => {
    const mention: RenderedContext[number] = {
      ...textSeg(500, '<message id="m1" mentionsMe="true">@LarkBot answer me</message>'),
      mentionsMe: true,
    };
    const chatter = Array.from({ length: 30 }, (_, i) => bigSeg(i)); // 500 est tokens each
    const result = composeProbeContext([mention, ...chatter], [], 1000, undefined, {
      lastActedMs: 0,
      previousStartMs: null,
    });
    expect(result!.overCap).toBe(true);
    expect(result!.windowStartMs).toBeGreaterThan(500);
    expect(result!.omittedCount).toBe(29);
    const text = result!.entries
      .flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    const mentionIndex = text.indexOf('@LarkBot answer me');
    const markerIndex = text.indexOf('<omitted messages="29"/>');
    const sliceIndex = text.indexOf('message 29:');
    expect(mentionIndex).toBeGreaterThanOrEqual(0);
    // The marker sits after the kept older pinned item and before the slice.
    expect(markerIndex).toBeGreaterThan(mentionIndex);
    expect(sliceIndex).toBeGreaterThan(markerIndex);
  });

  it('leaves the primary context untouched', () => {
    const rc = Array.from({ length: 10 }, (_, i) => bigSeg(i));
    const primary = composeContext(rc, [], 1_000_000, CURRENT_MODEL);
    const text = primary!.entries.flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(text).toContain('message 0');
    expect(text).toContain('message 9');
  });
});

describe('lastActedAtMs', () => {
  const actionTR = (ts: number, name: 'send_message' | 'react', ok: boolean): TurnResponseV2 => tr(ts, [
    assistantToolCall(`a${ts}`, name),
    toolResult(`a${ts}`, JSON.stringify(ok ? { ok: true, message_id: 'm' } : { error: 'failed' })),
  ]);

  it('uses own messages and successful send/react turns, not silent or failed turns', () => {
    const rc: RenderedContext = [
      textSeg(100, 'incoming'),
      { ...textSeg(200, 'own message'), isMyself: true },
      { ...textSeg(300, 'incoming later') },
    ];
    expect(lastActedAtMs(rc, [])).toBe(200);
    // A successful send_message or react counts as acting.
    expect(lastActedAtMs([], [actionTR(250, 'send_message', true)])).toBe(250);
    expect(lastActedAtMs([], [actionTR(260, 'react', true)])).toBe(260);
    // An end_turn-only turn and failed sends/reacts do not.
    const silent = tr(270, [assistantToolCall('e1', 'end_turn'), toolResult('e1', JSON.stringify({ ok: true }))]);
    expect(lastActedAtMs([], [silent])).toBe(0);
    expect(lastActedAtMs([], [actionTR(280, 'send_message', false)])).toBe(0);
    expect(lastActedAtMs([], [actionTR(290, 'react', false)])).toBe(0);
    // A later own message (e.g. sent by another program on the bot account)
    // wins over older successful turns.
    expect(lastActedAtMs(rc, [actionTR(250, 'send_message', true)])).toBe(250);
    expect(lastActedAtMs([...rc, { ...textSeg(400, 'own later'), isMyself: true }], [actionTR(250, 'send_message', true)])).toBe(400);
  });
});

describe('composeProbeContext — late-delivered events', () => {
  it('keeps an event received after the last action even below a newer processed watermark', () => {
    const rc: RenderedContext = [
      { ...textSeg(5000, 'own message'), isMyself: true },
      // Late retry: old platform time, but receivedAtMs after the last action.
      textSeg(6000, `late:${'x'.repeat(800)}`),
      textSeg(7000, `chatter:${'y'.repeat(1000)}`),
    ];
    const lastActedMs = lastActedAtMs(rc, []);
    expect(lastActedMs).toBe(5000);
    // maxEstTokens 1000, target 500: the ~900-token mandatory region (late +
    // chatter) fits, and the late event must stay with it.
    const result = composeProbeContext(rc, [], 1000, undefined, { lastActedMs, previousStartMs: null });
    expect(result!.windowStartMs).toBe(6000);
    const text = result!.entries
      .flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(text).toContain('late:');
  });
});

describe('composeContext — opaque reasoning accounting', () => {
  it('counts signatures and encrypted payloads at ~4 chars/token', () => {
    const rc: RenderedContext = [textSeg(100, 'hi')];
    const emptyThinking: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', reasoning: undefined,
      parts: [
        { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: '' } } },
        { kind: 'text', text: 'answer' },
      ],
    }];
    const signedThinking: ConversationEntry[] = [{
      kind: 'message', role: 'assistant', reasoning: undefined,
      parts: [
        {
          kind: 'reasoning',
          data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: '', signature: 's'.repeat(400) } },
        },
        { kind: 'text', text: 'answer' },
      ],
    }];
    const base = composeContext(rc, [tr(200, emptyThinking)], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    const signed = composeContext(rc, [tr(200, signedThinking)], 1_000_000, CURRENT_MODEL)!.rawEstimatedTokens;
    expect(signed - base).toBe(100); // 400 opaque chars / 4, not / 2
  });
});

describe('composeContext — reasoning beside tool_use', () => {
  it('keeps an Anthropic thinking block attached to tool_use in an old interrupted chain', () => {
    const rc: RenderedContext = [textSeg(50, 'hi')];
    const chainTR = (ts: number, callId: string, requiresFollowUp: boolean): TurnResponseV2 => tr(ts, [
      {
        kind: 'message',
        role: 'assistant',
        reasoning: undefined,
        parts: [
          {
            kind: 'reasoning',
            data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: 'why', signature: 'sig' } },
          },
          { kind: 'toolCall', callId, name: 'read', args: '{}' },
        ],
      },
      { kind: 'toolResult', callId, payload: 'ok', requiresFollowUp },
    ]);
    const trs = [tr(100, [assistantText('old closed turn')]), chainTR(200, 'c1', true), chainTR(300, 'c2', false)];
    const result = composeContext(rc, trs, 1_000_000, CURRENT_MODEL, undefined, 1);
    const assistants = result!.entries.filter(
      (e): e is OutputMessage => e.kind === 'message' && e.role === 'assistant',
    );
    expect(assistants).toHaveLength(3);
    expect(assistants[0]!.parts.some(p => p.kind === 'reasoning')).toBe(false);
    expect(assistants[1]!.parts.some(p => p.kind === 'reasoning')).toBe(true);
    expect(assistants[1]!.parts.some(p => p.kind === 'toolCall')).toBe(true);
    expect(assistants[2]!.parts.some(p => p.kind === 'reasoning')).toBe(true);
  });
});

describe('findWorkingWindowCursor — post-strip estimation', () => {
  const textOfTokens = (tokens: number): string => 'x'.repeat(tokens * 2);

  it('does not drop an old TR whose only bloat is stripped reasoning', () => {
    const rc = [textSeg(300, textOfTokens(50))];
    const hugeReasoning = tr(100, [{
      kind: 'message',
      role: 'assistant',
      reasoning: { reasoning_content: 'r'.repeat(200_000) },
      parts: [{ kind: 'text', text: textOfTokens(50) }],
    }]);
    const newest = tr(200, [assistantText(textOfTokens(50))]);
    // K=1 strips the older TR's reasoning; its real request size is small, so
    // the whole timeline fits and the cursor keeps the oldest entry.
    expect(findWorkingWindowCursor(rc, [hugeReasoning, newest], 200, CURRENT_MODEL, 1)).toBe(100);
    // Without the request-side view the reasoning overflows on its own.
    expect(findWorkingWindowCursor(rc, [hugeReasoning, newest], 200)).toBe(101);
  });
});

describe('composeContext — summary protection', () => {
  it('never trims the existing summary; oldest raw entries are trimmed first', () => {
    const oldMarker = 'o'.repeat(2000);
    const newMarker = 'n'.repeat(2000);
    const rc = [textSeg(100, oldMarker), textSeg(200, newMarker)];
    const result = composeContext(rc, [], 1200, CURRENT_MODEL, `SUMMARY-${'S'.repeat(90)}`);
    const text = result!.entries
      .flatMap(e => e.kind === 'message' ? e.parts.map(p => p.kind === 'text' ? p.text : '') : []).join('\n');
    expect(text).toContain(`SUMMARY-${'S'.repeat(90)}`);
    expect(text).toContain(newMarker);
    expect(text).not.toContain(oldMarker);
  });
});
