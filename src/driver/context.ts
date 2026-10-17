import { mergeContext } from './merge';
import type { TurnResponseV2 } from './types';
import type { RenderedContext, RenderedContextSegment } from '../rendering/types';
import { messageReasoningText, stripReasoning } from '../unified-api/reasoning';
import type {
  ConversationEntry,
  InputMessage,
  InputPart,
  MessageReasoning,
  OutputMessage,
  ReasoningData,
  ToolResult,
} from '../unified-api/types';

// Calibrated against live DeepSeek requests (2026-10-17): the primary request
// held ~532K text/reasoning chars → 262,248 input tokens and the probe ~416K
// chars → 205,322 (~2.0 chars/token aggregate). Mixed CJK/XML ids/English
// balance out, so one blended rate is closer to the provider tokenizer than
// separate CJK/ASCII rates.
const CHARS_PER_TOKEN = 2;
// Image token estimation: thumbnails ≤ 75_000 px → ~100 tokens (Claude formula).
const IMAGE_TOKENS = 100;

const charsTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);
const textTokens = (text: string): number => charsTokens(text.length);

const partTokens = (part: InputPart): number =>
  part.kind === 'image' ? IMAGE_TOKENS : textTokens(part.text);

const toolResultTokens = (tr: ToolResult): number =>
  typeof tr.payload === 'string'
    ? textTokens(tr.payload)
    : tr.payload.reduce((a, p) => a + partTokens(p), 0);

// Reasoning is replayed on the wire (thinking blocks, reasoning_content),
// so it must count; ignoring it undercounted the live primary turn by ~25%.
// Opaque blobs (Anthropic signatures, OpenAI encrypted_content, redacted
// thinking, reasoning_opaque) are base64/encrypted payloads that tokenize at
// roughly 1 token per 4 chars, unlike the ~2 chars/token of prose and XML.
const OPAQUE_CHARS_PER_TOKEN = 4;
const opaqueTokens = (chars: number): number => Math.ceil(chars / OPAQUE_CHARS_PER_TOKEN);

const reasoningDataTokens = (data: ReasoningData): number => {
  if (data.source === 'openaiResponses') {
    const { summary, encrypted_content } = data.data;
    return summary.reduce((a, s) => a + textTokens(s.text), 0)
      + (encrypted_content === undefined ? 0 : opaqueTokens(encrypted_content.length));
  }
  if (data.data.type === 'thinking') {
    return textTokens(data.data.thinking)
      + (data.data.signature === undefined ? 0 : opaqueTokens(data.data.signature.length));
  }
  return opaqueTokens(data.data.data.length);
};

const messageReasoningTokens = (r: MessageReasoning): number =>
  textTokens(messageReasoningText(r) ?? '')
  + (typeof r.reasoning_opaque === 'string' ? opaqueTokens(r.reasoning_opaque.length) : 0);

const outputPartTokens = (part: OutputMessage['parts'][number]): number => {
  if (part.kind === 'text') return textTokens(part.text);
  if (part.kind === 'toolCall') return textTokens(part.name + part.args);
  if (part.kind === 'textGroup') return part.content.reduce((a, t) => a + textTokens(t.text), 0);
  return reasoningDataTokens(part.data);
};

const entryTokens = (e: ConversationEntry): number => {
  if (e.kind === 'toolResult') return toolResultTokens(e);
  if (e.role === 'assistant') {
    const parts = e.parts.reduce((a, p) => a + outputPartTokens(p), 0);
    return parts + (e.reasoning === undefined ? 0 : messageReasoningTokens(e.reasoning));
  }
  return e.parts.reduce((a, p) => a + partTokens(p), 0);
};

const renderedContentTokens = (content: RenderedContextSegment['content']): number =>
  content.reduce((a, p) => a + (p.type === 'text' ? textTokens(p.text) : IMAGE_TOKENS), 0);

export const latestExternalEventMs = (rc: RenderedContext, afterMs: number): number | null => {
  let latest: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs > afterMs && !seg.isMyself && (latest == null || seg.receivedAtMs > latest))
      latest = seg.receivedAtMs;
  }
  return latest;
};

// For the debounce: anchor the wait to the "trigger sender" — the sender of the
// oldest unprocessed external message that opened the window. Returns the latest
// message time among that sender's unprocessed messages, so only their further
// messages extend the window (others' messages don't). Returns null when there
// is no unprocessed external input.
export const triggerSenderLatestMs = (rc: RenderedContext, afterMs: number): number | null => {
  let triggerSenderId: string | undefined;
  let oldestMs: number | null = null;
  for (const seg of rc) {
    if (seg.receivedAtMs <= afterMs || seg.isMyself) continue;
    if (oldestMs == null || seg.receivedAtMs < oldestMs) {
      oldestMs = seg.receivedAtMs;
      triggerSenderId = seg.senderId;
    }
  }
  if (oldestMs == null) return null;

  let latest = oldestMs;
  for (const seg of rc) {
    if (seg.receivedAtMs <= afterMs || seg.isMyself) continue;
    if (seg.senderId === triggerSenderId && seg.receivedAtMs > latest)
      latest = seg.receivedAtMs;
  }
  return latest;
};

const trHasToolCalls = (tr: TurnResponseV2): boolean =>
  tr.entries.some(e => e.kind === 'message' && e.role === 'assistant'
    && e.parts.some(p => p.kind === 'toolCall'));

export const wasToolLoopInterrupted = (trs: TurnResponseV2[]): boolean => {
  if (trs.length === 0) return false;
  const entries = trs[trs.length - 1]!.entries;
  const toolResults = entries.filter((e): e is ToolResult => e.kind === 'toolResult');
  if (toolResults.length === 0) return false;
  return toolResults.some(tr => tr.requiresFollowUp);
};

const KEEP_NO_TOOL_CALL_TRS = 5;

const trimStaleNoToolCallTRs = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const noToolIndices: number[] = [];
  for (let i = 0; i < trs.length; i++)
    if (!trHasToolCalls(trs[i]!)) noToolIndices.push(i);
  if (noToolIndices.length <= KEEP_NO_TOOL_CALL_TRS) return trs;
  const dropSet = new Set(noToolIndices.slice(0, noToolIndices.length - KEEP_NO_TOOL_CALL_TRS));
  return trs.filter((_, i) => !dropSet.has(i));
};

const TOOL_RESULT_TRIM_THRESHOLD = 512;
const TOOL_RESULT_KEEP_RECENT_OVERSIZED = 5;

const safePrefix = (text: string, length: number): string => {
  const prefix = text.slice(0, length);
  return (prefix.charCodeAt(prefix.length - 1) & 0xFC00) === 0xD800
    ? prefix.slice(0, -1)
    : prefix;
};

const safeSuffix = (text: string, length: number): string => {
  const suffix = text.slice(-length);
  return (suffix.charCodeAt(0) & 0xFC00) === 0xDC00
    ? suffix.slice(1)
    : suffix;
};

const trimLongText = (text: string): string => {
  if (text.length <= TOOL_RESULT_TRIM_THRESHOLD) return text;
  const prefix = safePrefix(text, 200);
  const suffix = safeSuffix(text, 200);
  return `${prefix}\n... [trimmed ${text.length} chars] ...\n${suffix}`;
};

const joinToolResultText = (parts: InputPart[]): string =>
  parts.flatMap(p => p.kind === 'text' ? [p.text] : []).join('\n');

const toolResultExceedsLimit = (tr: ToolResult): boolean => {
  if (typeof tr.payload === 'string') return tr.payload.length > TOOL_RESULT_TRIM_THRESHOLD;
  return joinToolResultText(tr.payload).length > TOOL_RESULT_TRIM_THRESHOLD
    || tr.payload.some(p => p.kind === 'image' && p.detail !== 'low');
};

const trimToolResultPayload = (tr: ToolResult): ToolResult => {
  if (typeof tr.payload === 'string') return { ...tr, payload: trimLongText(tr.payload) };
  const joined = joinToolResultText(tr.payload);
  const shouldTrimText = joined.length > TOOL_RESULT_TRIM_THRESHOLD;
  const trimmed = shouldTrimText ? trimLongText(joined) : null;
  let emitted = false;
  const newParts: InputPart[] = tr.payload.flatMap((p): InputPart[] => {
    if (p.kind === 'image') return [{ ...p, detail: 'low' as const }];
    if (!shouldTrimText) return [p];
    if (emitted) return [];
    emitted = true;
    return [{ ...p, text: trimmed! }];
  });
  return { ...tr, payload: newParts };
};

const trimToolResults = (trs: TurnResponseV2[]): TurnResponseV2[] => {
  const positions: Array<{ trIndex: number; entryIndex: number }> = [];
  for (let ti = 0; ti < trs.length; ti++) {
    const entries = trs[ti]!.entries;
    for (let ei = 0; ei < entries.length; ei++) {
      const e = entries[ei]!;
      if (e.kind === 'toolResult' && toolResultExceedsLimit(e))
        positions.push({ trIndex: ti, entryIndex: ei });
    }
  }
  if (positions.length <= TOOL_RESULT_KEEP_RECENT_OVERSIZED) return trs;
  const toTrim = new Map<number, Set<number>>();
  for (const { trIndex, entryIndex } of positions.slice(0, positions.length - TOOL_RESULT_KEEP_RECENT_OVERSIZED)) {
    const set = toTrim.get(trIndex) ?? new Set<number>();
    set.add(entryIndex);
    toTrim.set(trIndex, set);
  }
  return trs.map((tr, ti) => {
    const set = toTrim.get(ti);
    if (!set) return tr;
    return {
      ...tr,
      entries: tr.entries.map((e, ei) =>
        e.kind === 'toolResult' && set.has(ei) ? trimToolResultPayload(e) : e),
    };
  });
};

const filterSelfSentSegments = (rc: RenderedContext): RenderedContext =>
  rc.filter(seg => !seg.isSelfSent);

// Tools whose successful execution counts as the bot having acted. An
// `end_turn`-only turn, a rejected call, or a call whose tool result is an
// error must not move the probe's mandatory boundary.
const ACTION_TOOL_NAMES: ReadonlySet<string> = new Set(['send_message', 'react']);

const toolCallSucceeded = (tr: TurnResponseV2): ReadonlySet<string> => {
  const successful = new Set<string>();
  for (const e of tr.entries) {
    if (e.kind !== 'toolResult' || typeof e.payload !== 'string') continue;
    try {
      const parsed = JSON.parse(e.payload) as unknown;
      if (parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true)
        successful.add(e.callId);
    } catch { /* tool results are not always JSON */ }
  }
  return successful;
};

const trHasAction = (tr: TurnResponseV2): boolean => {
  const successful = toolCallSucceeded(tr);
  if (successful.size === 0) return false;
  return tr.entries.some(e =>
    e.kind === 'message' && e.role === 'assistant'
    && e.parts.some(p => p.kind === 'toolCall'
      && ACTION_TOOL_NAMES.has(p.name) && successful.has(p.callId)));
};

// Latest time the bot actually acted: its own latest message (including
// synthetic self-sends) or its latest primary turn that successfully sent a
// message or reacted. Probes are judgments, not actions, and neither is a
// silent end_turn or a failed send, so those must not move the probe window's
// mandatory region past an unanswered direct address.
export const lastActedAtMs = (rc: RenderedContext, trs: TurnResponseV2[]): number => {
  let latest = 0;
  for (const seg of rc) if (seg.isMyself && seg.receivedAtMs > latest) latest = seg.receivedAtMs;
  for (const tr of trs) if (tr.requestedAtMs > latest && trHasAction(tr)) latest = tr.requestedAtMs;
  return latest;
};

// A TR continues into the next one while it persisted a follow-up result. The
// resulting suffix is the current interrupted chain; providers that require
// thinking blocks beside pending tool_use (Anthropic) must keep its reasoning.
const hasFollowUpResult = (tr: TurnResponseV2): boolean =>
  tr.entries.some(e => e.kind === 'toolResult' && e.requiresFollowUp);

// First TR index whose reasoning survives replay: the union of the newest
// `keepTurns` responses and the interrupted chain suffix.
export const reasoningKeepFrom = (trs: TurnResponseV2[], keepTurns: number): number => {
  if (trs.length === 0) return 0;
  let chainStart = trs.length - 1;
  for (let i = trs.length - 2; i >= 0; i--) {
    if (!hasFollowUpResult(trs[i]!)) break;
    chainStart = i;
  }
  return Math.min(Math.max(0, trs.length - keepTurns), chainStart);
};

// The request-side view of stored TRs: reasoning is stripped from mismatched
// models and from everything older than `keepTurns` plus the interrupted chain.
const stripReplayReasoning = (
  trs: TurnResponseV2[], currentModelName: string, keepTurns: number,
): TurnResponseV2[] => {
  const keepFrom = reasoningKeepFrom(trs, keepTurns);
  return trs.map((tr, index) =>
    tr.modelName === currentModelName && index >= keepFrom
      ? tr
      : { ...tr, entries: stripReasoning(tr.entries) });
};

/**
 * Walk backward through RC + TR timeline until budget is reached.
 * Returns receivedAtMs of the cutoff point (entries newer than it stay).
 *
 * When `currentModelName` is given, TR sizes use the request-side view (the
 * same reasoning stripping as `composeContext`), so a huge replayed reasoning
 * blob cannot alone empty the working window.
 */
export const findWorkingWindowCursor = (
  rc: RenderedContext, trs: TurnResponseV2[], budgetTokens: number,
  currentModelName?: string, reasoningReplayTurns = 3,
): number => {
  type Entry = { timeMs: number; tokens: number };
  const entries: Entry[] = [];
  for (const seg of rc) {
    entries.push({ timeMs: seg.receivedAtMs, tokens: renderedContentTokens(seg.content) });
  }
  const requestTRs = currentModelName === undefined
    ? trs
    : stripReplayReasoning(trs, currentModelName, reasoningReplayTurns);
  for (const tr of requestTRs) {
    const tokens = tr.entries.reduce((a, e) => a + entryTokens(e), 0);
    entries.push({ timeMs: tr.requestedAtMs, tokens });
  }
  entries.sort((a, b) => b.timeMs - a.timeMs);
  let accum = 0;
  for (const entry of entries) {
    accum += entry.tokens;
    if (accum > budgetTokens) {
      // This entry overflows the working budget, so it must be compacted away.
      // Callers retain entries with `receivedAtMs >= cursor`, so returning this
      // entry's own timestamp would keep it in the working window forever and
      // pin the cursor (`newCursorMs === oldCursorMs`), leaving every later
      // compaction window empty. Cut strictly after it so it is excluded.
      return entry.timeMs + 1;
    }
  }
  return entries.at(-1)!.timeMs;
};

/**
 * Walk forward from `oldCursorMs` through the post-strip timeline (RC segments
 * + TRs, the same view `composeContext` builds) and stop before `budgetTokens`
 * would be exceeded. The returned cursor is the boundary after the last entry
 * that fits, so `[oldCursorMs, cursorMs)` is what one compaction request can
 * summarize. The first entry is included even when it alone overflows, so the
 * cursor always advances (the caller logs that case).
 */
export const findCompactionCapCursor = (
  rc: RenderedContext, trs: TurnResponseV2[], oldCursorMs: number, budgetTokens: number,
  currentModelName: string, reasoningReplayTurns: number,
): { cursorMs: number; estimatedTokens: number; oversizedFirst: boolean } => {
  type Entry = { timeMs: number; tokens: number };
  const entries: Entry[] = [];
  for (const seg of rc) {
    if (seg.receivedAtMs < oldCursorMs) continue;
    entries.push({ timeMs: seg.receivedAtMs, tokens: renderedContentTokens(seg.content) });
  }
  for (const tr of stripReplayReasoning(trs, currentModelName, reasoningReplayTurns)) {
    if (tr.requestedAtMs < oldCursorMs) continue;
    entries.push({ timeMs: tr.requestedAtMs, tokens: tr.entries.reduce((a, e) => a + entryTokens(e), 0) });
  }
  entries.sort((a, b) => a.timeMs - b.timeMs);

  let total = 0;
  let lastIncludedMs: number | null = null;
  let oversizedFirst = false;
  for (const entry of entries) {
    if (lastIncludedMs !== null && total + entry.tokens > budgetTokens) break;
    total += entry.tokens;
    lastIncludedMs = entry.timeMs;
    if (total > budgetTokens) {
      oversizedFirst = true;
      break;
    }
  }
  return {
    cursorMs: lastIncludedMs === null ? oldCursorMs : lastIncludedMs + 1,
    estimatedTokens: total,
    oversizedFirst,
  };
};

const trimEntries = (entries: ConversationEntry[], maxTokens: number): { entries: ConversationEntry[]; estimatedTokens: number } => {
  let total = entries.reduce((a, e) => a + entryTokens(e), 0);
  if (total <= maxTokens) return { entries, estimatedTokens: total };

  // Clone user-message part arrays before trimming so caller input remains unchanged.
  const result: ConversationEntry[] = entries.map(e =>
    e.kind === 'message' && e.role === 'user' ? { ...e, parts: [...e.parts] } : e);

  while (total > maxTokens && result.length > 0) {
    const first = result[0]!;

    if (first.kind === 'message' && first.role === 'user' && first.parts.length > 0) {
      if (first.parts.length <= 1 && result.length <= 1) break;
      const dropped = (first as InputMessage).parts.shift()!;
      total -= partTokens(dropped);
      if ((first as InputMessage).parts.length === 0) result.shift();
    } else if (result.length > 1) {
      const dropped = result.shift()!;
      total -= entryTokens(dropped);
      // If dropped assistant had toolCall parts, also drop following toolResults
      if (dropped.kind === 'message' && dropped.role === 'assistant'
        && dropped.parts.some(p => p.kind === 'toolCall')) {
        while (result.length > 0 && result[0]!.kind === 'toolResult')
          total -= entryTokens(result.shift()!);
      }
    } else {
      break;
    }
  }

  // Never start with an orphaned toolResult
  while (result.length > 1 && result[0]!.kind === 'toolResult')
    total -= entryTokens(result.shift()!);

  return { entries: result, estimatedTokens: total };
};

export const composeContext = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  maxTokens: number,
  currentModelName: string,
  compactSummary?: string,
  reasoningReplayTurns = 3,
): { entries: ConversationEntry[]; estimatedTokens: number; rawEstimatedTokens: number } | null => {
  const effectiveRC = filterSelfSentSegments(rc);

  // Strip reasoning from TRs whose modelName does not match the current model
  // (signatures only round-trip within one model), and from all but the newest
  // `reasoningReplayTurns` responses plus the current interrupted chain.
  const sanitizedTRs = trimToolResults(
    trimStaleNoToolCallTRs(
      stripReplayReasoning(trs, currentModelName, reasoningReplayTurns),
    ),
  );

  const merged = mergeContext(effectiveRC, sanitizedTRs);
  if (merged.length === 0 && !compactSummary) return null;

  // Drop assistant messages that became empty after reasoning strip (no content,
  // no tool calls left).
  const cleaned = merged.filter(e => {
    if (e.kind !== 'message' || e.role !== 'assistant') return true;
    return e.parts.length > 0;
  });

  // The existing summary is protected: only raw entries compete for the budget,
  // so front trimming can never cut the summary first (which previously lost
  // the entire old history when a compaction window overflowed the cap).
  const summaryEntry: InputMessage | undefined = compactSummary === undefined
    ? undefined
    : { kind: 'message', role: 'user', parts: [{ kind: 'text', text: `[Conversation summary]\n${compactSummary}` }] };
  const summaryTokens = summaryEntry === undefined ? 0 : entryTokens(summaryEntry);
  const rawEstimatedTokens = cleaned.reduce((a, e) => a + entryTokens(e), 0) + summaryTokens;
  const trimmed = trimEntries(cleaned, Math.max(0, maxTokens - summaryTokens));
  const entries = summaryEntry === undefined ? trimmed.entries : [summaryEntry, ...trimmed.entries];
  return { entries, estimatedTokens: trimmed.estimatedTokens + summaryTokens, rawEstimatedTokens };
};

/**
 * Probe sees an outside-judge view: chat history as XML, plus a compact
 * XML rendering of past tool calls (excluding `send_message`, which is
 * already represented by the bot's own message in the chat). Each
 * toolCall/toolResult pair becomes one `<tool-call>` element, aggressively
 * truncated. The bot's `isSelfSent` segments stay (filterSelfSentSegments
 * is NOT applied) so the bot's outgoing messages show up as `<message>`.
 * Compact summary rides along for context.
 */
const PROBE_TOOL_CALL_TRUNCATE = 1024;

const truncateForProbe = (s: string): string => {
  if (s.length <= PROBE_TOOL_CALL_TRUNCATE) return s;
  const head = Math.floor(PROBE_TOOL_CALL_TRUNCATE * 0.4);
  const tail = Math.floor(PROBE_TOOL_CALL_TRUNCATE * 0.4);
  return `${safePrefix(s, head)}\n... [truncated ${s.length - head - tail} chars] ...\n${safeSuffix(s, tail)}`;
};

const formatToolResultPayload = (payload: string | InputPart[]): string => {
  if (typeof payload === 'string') return payload;
  const texts: string[] = [];
  let imageCount = 0;
  for (const p of payload) {
    if (p.kind === 'text') texts.push(p.text);
    else if (p.kind === 'image') imageCount++;
  }
  let s = texts.join('\n');
  if (imageCount > 0) s += `${s ? '\n' : ''}[${imageCount} image${imageCount > 1 ? 's' : ''} attached]`;
  return s;
};

// Wrap arbitrary text in CDATA, escaping the only sequence CDATA can't hold.
const cdata = (s: string): string =>
  `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

const xmlEscapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const synthesizeToolCallSegments = (trs: TurnResponseV2[]): { receivedAtMs: number; content: { type: 'text'; text: string }[] }[] => {
  const segments: { receivedAtMs: number; content: { type: 'text'; text: string }[] }[] = [];
  for (const tr of trs) {
    const results = new Map<string, ToolResult>();
    for (const e of tr.entries) {
      if (e.kind === 'toolResult') results.set(e.callId, e);
    }
    for (const e of tr.entries) {
      if (e.kind !== 'message' || e.role !== 'assistant') continue;
      for (const p of e.parts) {
        if (p.kind !== 'toolCall') continue;
        // send_message is already represented as the bot's own <message> in the
        // chat XML — skip to avoid duplicate signal.
        if (p.name === 'send_message') continue;
        const result = results.get(p.callId);
        const argsTrunc = truncateForProbe(p.args);
        const resultTrunc = result ? truncateForProbe(formatToolResultPayload(result.payload)) : null;
        const t = new Date(tr.requestedAtMs).toISOString();
        const inner = resultTrunc != null
          ? `<args>${cdata(argsTrunc)}</args>\n<result>${cdata(resultTrunc)}</result>`
          : `<args>${cdata(argsTrunc)}</args>\n<result>[no result — interrupted]</result>`;
        const xml = `<tool-call name="${xmlEscapeAttr(p.name)}" t="${t}">\n${inner}\n</tool-call>`;
        segments.push({
          receivedAtMs: tr.requestedAtMs,
          content: [{ type: 'text', text: xml }],
        });
      }
    }
  }
  return segments;
};

/** Per-chat probe window state; mutates only through the returned start. */
export interface ProbeWindowState {
  startMs: number | null;
}

// While the probe slice fits its budget the window start stays put, so the
// request prefix survives message churn and keeps its provider cache entry.
// Only when the slice grows past the budget does the start jump forward, to
// half the budget, and the prefix changes once.
const PROBE_WINDOW_TARGET_DIVISOR = 2;

export interface ProbeWindowSelection {
  startMs: number;
  /** Times of addressed segments kept regardless of the start (over-cap pins). */
  pinnedReceivedAtMs: number[];
  /** Context segments dropped before the window start. */
  omittedCount: number;
  omittedEstTokens: number;
  /** The region since the last action alone exceeded the budget. */
  overCap: boolean;
}

export const selectProbeWindowStart = (params: {
  /** Probe segments (RC + synthesized tool calls), ascending by receivedAtMs. */
  segments: { receivedAtMs: number; tokens: number; mentionsMe?: boolean; repliesToMe?: boolean }[];
  maxEstTokens: number;
  lastActedMs: number;
  previousStartMs: number | null;
}): ProbeWindowSelection | null => {
  const { segments, maxEstTokens, lastActedMs, previousStartMs } = params;
  if (segments.length === 0) return null;
  const targetEstTokens = Math.max(1, Math.floor(maxEstTokens / PROBE_WINDOW_TARGET_DIVISOR));

  // Direct addresses since the last action are pinned: however old they are,
  // the over-cap fallback must not drop them. RC already carries the flags.
  const pinnedTimes = new Set<number>();
  for (const s of segments)
    if (s.receivedAtMs > lastActedMs && (s.mentionsMe === true || s.repliesToMe === true))
      pinnedTimes.add(s.receivedAtMs);

  // Oldest segment that must stay because it arrived after the bot last acted.
  let mandatoryStartMs: number | null = null;
  for (const s of segments)
    if (s.receivedAtMs > lastActedMs && (mandatoryStartMs == null || s.receivedAtMs < mandatoryStartMs))
      mandatoryStartMs = s.receivedAtMs;

  const tokensFrom = (startMs: number): number => {
    let total = 0;
    for (const s of segments) if (s.receivedAtMs >= startMs || pinnedTimes.has(s.receivedAtMs)) total += s.tokens;
    return total;
  };

  // Start of the newest suffix fitting `budget`; the newest segment is kept
  // even when it alone overflows.
  const walkBackStart = (budget: number): number => {
    let total = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      total += segments[i]!.tokens;
      if (total > budget)
        return i + 1 < segments.length ? segments[i + 1]!.receivedAtMs : segments[i]!.receivedAtMs;
    }
    return segments[0]!.receivedAtMs;
  };

  const targetStartMs = walkBackStart(targetEstTokens);
  const overCap = mandatoryStartMs != null && tokensFrom(mandatoryStartMs) > maxEstTokens;

  let startMs: number;
  if (overCap) {
    // Keep the newest target suffix plus pinned addresses (below). The
    // fallback start is held with the same hysteresis as the normal path, so
    // it only jumps once the kept slice exceeds the budget again.
    startMs = previousStartMs != null && tokensFrom(previousStartMs) <= maxEstTokens
      ? previousStartMs
      : targetStartMs;
  } else if (previousStartMs == null) {
    startMs = mandatoryStartMs == null ? targetStartMs : Math.min(targetStartMs, mandatoryStartMs);
  } else {
    const stableStartMs = mandatoryStartMs == null ? previousStartMs : Math.min(previousStartMs, mandatoryStartMs);
    startMs = tokensFrom(stableStartMs) > maxEstTokens
      ? (mandatoryStartMs == null ? targetStartMs : Math.min(targetStartMs, mandatoryStartMs))
      : stableStartMs;
  }

  let omittedCount = 0;
  let omittedEstTokens = 0;
  for (const s of segments) {
    if (s.receivedAtMs >= startMs || pinnedTimes.has(s.receivedAtMs)) continue;
    omittedCount++;
    omittedEstTokens += s.tokens;
  }
  return { startMs, pinnedReceivedAtMs: [...pinnedTimes], omittedCount, omittedEstTokens, overCap };
};

/** Estimated tokens for plain text at the calibrated blended rate. */
export const estimateTextTokens = (text: string): number => textTokens(text);

// The compaction summary is chat-global context, not part of the recent slice:
// it is always included, never counts against `contextEstTokens`/the hysteresis
// target, and is only bounded by its own cap. It truncates from the end because
// deep history is what the summary carries; recent history is in the window.
const DEFAULT_PROBE_SUMMARY_MAX_EST_TOKENS = 20_000;

const truncateSummaryFromEnd = (summary: string, maxEstTokens: number): string => {
  const maxChars = maxEstTokens * CHARS_PER_TOKEN;
  return summary.length <= maxChars
    ? summary
    : `${summary.slice(0, maxChars)}\n[... summary truncated ...]`;
};

export const composeProbeContext = (
  rc: RenderedContext,
  trs: TurnResponseV2[],
  maxTokens: number,
  compactSummary?: string,
  window?: { lastActedMs: number; previousStartMs: number | null; summaryMaxEstTokens?: number },
): {
  entries: ConversationEntry[];
  estimatedTokens: number;
  rawEstimatedTokens: number;
  windowStartMs: number | null;
  omittedCount: number;
  omittedEstTokens: number;
  overCap: boolean;
} | null => {
  // Synthesize tool-call XML segments and merge them with RC by timestamp.
  // No real TRs go in — mergeContext receives [] for the trs side, so the
  // probe sees only XML user-message text (no assistant entries, no tool
  // results, no reasoning).
  const synthSegments = synthesizeToolCallSegments(trs);
  let augmentedRC: RenderedContext = [...rc, ...synthSegments];
  let selection: ProbeWindowSelection | null = null;
  if (window) {
    selection = selectProbeWindowStart({
      segments: augmentedRC
        .map(seg => ({
          receivedAtMs: seg.receivedAtMs,
          tokens: renderedContentTokens(seg.content),
          mentionsMe: seg.mentionsMe,
          repliesToMe: seg.repliesToMe,
        }))
        .sort((a, b) => a.receivedAtMs - b.receivedAtMs),
      maxEstTokens: maxTokens,
      lastActedMs: window.lastActedMs,
      previousStartMs: window.previousStartMs,
    });
    if (selection != null) {
      const startMs = selection.startMs;
      const pinned = new Set(selection.pinnedReceivedAtMs);
      augmentedRC = augmentedRC.filter(seg => seg.receivedAtMs >= startMs || pinned.has(seg.receivedAtMs));
      if (selection.omittedCount > 0) {
        // Mark the gap inline: probe RC segments all collapse into one user
        // message in timestamp order, so a segment just before the slice lands
        // between kept older pinned items and the newer window content.
        augmentedRC = [
          ...augmentedRC,
          {
            receivedAtMs: startMs - 1,
            content: [{ type: 'text', text: `<omitted messages="${selection.omittedCount}"/>` }],
          },
        ];
      }
    }
  }
  const merged = mergeContext(augmentedRC, []);
  if (merged.length === 0 && !compactSummary) return null;

  const summaryEntry: InputMessage | undefined = compactSummary === undefined
    ? undefined
    : {
        kind: 'message',
        role: 'user',
        parts: [{
          kind: 'text',
          text: `[Conversation summary]\n${truncateSummaryFromEnd(
            compactSummary,
            window?.summaryMaxEstTokens ?? DEFAULT_PROBE_SUMMARY_MAX_EST_TOKENS,
          )}`,
        }],
      };
  const summaryTokens = summaryEntry === undefined ? 0 : entryTokens(summaryEntry);
  const rawEstimatedTokens = merged.reduce((a, e) => a + entryTokens(e), 0) + summaryTokens;
  const trimmed = trimEntries(merged, maxTokens);
  const entries = summaryEntry === undefined ? trimmed.entries : [summaryEntry, ...trimmed.entries];
  return {
    entries,
    estimatedTokens: trimmed.estimatedTokens + summaryTokens,
    rawEstimatedTokens,
    windowStartMs: selection?.startMs ?? null,
    omittedCount: selection?.omittedCount ?? 0,
    omittedEstTokens: selection?.omittedEstTokens ?? 0,
    overCap: selection?.overCap ?? false,
  };
};

export const injectLateBindingPrompt = (entries: ConversationEntry[], prompt: string): void => {
  entries.push({
    kind: 'message',
    role: 'user',
    parts: [{ kind: 'text', text: prompt }],
  } satisfies InputMessage);
};
