import * as v from 'valibot';

import {
  bodyChars,
  defaultHeader,
  entryChars,
  findEntryByText,
  hearsayStats,
  isDuplicateText,
  isHearsay,
  isHearsayText,
  localDate,
  MAX_EVIDENCE_PER_ENTRY,
  normalizeText,
  refreshHeader,
  serializeEntry,
  withoutPrefix,
} from './format';
import { scanMemoryText } from './scan';
import { SELF_PATH, uidFromPath } from './types';
import type {
  ForgetRecord,
  MemoryConfig,
  MemoryEntry,
  MemoryFileContent,
  MemoryFileState,
  MemoryOpRecord,
  MemoryPath,
} from './types';
import type { MemoryWindow, WindowMessage } from './window';

export const MAX_OPS_PER_RUN = 60;
const MAX_TEXT_CHARS = 300;
const MIN_OLD_TEXT_CHARS = 4;
const MAX_OLD_TEXT_CHARS = 120;

// `evict` is deliberately absent: eviction is automatic, the model never picks
// what leaves a card.
const RawOpSchema = v.object({
  path: v.string(),
  op: v.picklist(['add', 'replace', 'remove']),
  intent: v.picklist(['add', 'owner', 'supersede']),
  old_text: v.optional(v.string()),
  text: v.optional(v.string()),
  evidence: v.optional(v.array(v.string())),
  reason: v.optional(v.string()),
});

export type RawMemoryOp = v.InferOutput<typeof RawOpSchema>;

export type ModelOutput =
  | { ok: true; ops: unknown[] }
  | { ok: false; why: string };

/** Strip an optional ```json fence and read `{"ops":[...]}`. */
export const parseModelOutput = (text: string): ModelOutput => {
  let body = text.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fence) body = fence[1]!.trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, why: 'unparseable_json' };
    try {
      value = JSON.parse(body.slice(start, end + 1));
    } catch {
      return { ok: false, why: 'unparseable_json' };
    }
  }
  const parsed = v.safeParse(v.object({ ops: v.array(v.unknown()) }), value);
  return parsed.success ? { ok: true, ops: parsed.output.ops } : { ok: false, why: 'bad_output_shape' };
};

export interface ParsedOps {
  valid: RawMemoryOp[];
  // Ops that do not even match the schema, with whatever path they named.
  invalid: { path: string; raw: string }[];
}

export const parseOps = (rawOps: readonly unknown[]): ParsedOps => {
  const result: ParsedOps = { valid: [], invalid: [] };
  for (const raw of rawOps.slice(0, MAX_OPS_PER_RUN)) {
    const parsed = v.safeParse(RawOpSchema, raw);
    if (parsed.success) {
      result.valid.push(parsed.output);
      continue;
    }
    const path = typeof raw === 'object' && raw !== null && typeof (raw as { path?: unknown }).path === 'string'
      ? (raw as { path: string }).path
      : '(unknown)';
    result.invalid.push({ path, raw: JSON.stringify(raw).slice(0, 500) });
  }
  return result;
};

export type EvidenceStatus = 'deleted' | 'alive' | 'unknown';

export interface PlanContext {
  chatId: string;
  window: MemoryWindow;
  config: MemoryConfig;
  model: string;
  atMs: number;
  // Recent owner removals, for the do-not-readd rule.
  forgets: readonly ForgetRecord[];
  // Positive deletion status of an existing entry's evidence alias.
  evidenceStatus: (alias: string) => EvidenceStatus;
}

export interface FilePlan {
  path: MemoryPath;
  baseHash: string | null;
  next: MemoryFileContent | null;
  records: MemoryOpRecord[];
  forgets: ForgetRecord[];
  // At least one model op targeted this file.
  hadOps: boolean;
  // The whole file was refused (over budget); nothing of it is written.
  rejected: boolean;
}

interface WorkEntry {
  entry: MemoryEntry;
  // Present while the entry was added or rewritten by this batch.
  origin?: { record: MemoryOpRecord; kind: 'add' | 'replace'; before?: MemoryEntry };
}

type WritableState = Extract<MemoryFileState, { status: 'ok' | 'missing' }>;

const newestMessage = (messages: readonly WindowMessage[]): WindowMessage =>
  messages.reduce((best, message) =>
    message.timestampSec > best.timestampSec
    || (message.timestampSec === best.timestampSec && message.receivedAtMs > best.receivedAtMs)
      ? message
      : best);

const byAge = (a: { entry: MemoryEntry; index: number }, b: { entry: MemoryEntry; index: number }): number =>
  a.entry.date === b.entry.date ? a.index - b.index : (a.entry.date < b.entry.date ? -1 : 1);

/**
 * Plan one file: sweep evidence, apply the model's ops in order, trim hearsay,
 * then enforce the budget by automatic eviction. Pure: the caller loads the
 * state and hands the plan to the backend.
 */
export const planFile = (
  path: MemoryPath,
  state: WritableState,
  ops: readonly RawMemoryOp[],
  context: PlanContext,
): FilePlan => {
  const { chatId, window, config } = context;
  const isSelf = path === SELF_PATH;
  const uid = uidFromPath(path);
  const budget = isSelf ? config.selfMaxChars : config.cardMaxChars;
  const records: MemoryOpRecord[] = [];
  const forgets: ForgetRecord[] = [];

  const base = (extra: Partial<MemoryOpRecord> & Pick<MemoryOpRecord, 'op' | 'intent'>): MemoryOpRecord => ({
    at: context.atMs,
    chatId,
    file: path,
    outcome: 'applied',
    actor: 'consolidator',
    model: context.model,
    cursorAfterMs: window.endMs,
    ...extra,
  });

  let working: WorkEntry[] = state.entries.map(entry => ({ entry }));
  const initialEntries = state.entries;

  // Deleting a message acts as forget: an entry whose evidence is all positively
  // deleted goes; one with some living evidence keeps only the living aliases.
  // An alias that cannot be resolved counts as alive.
  working = working.flatMap((item): WorkEntry[] => {
    const evidence = item.entry.evidence;
    if (evidence.length === 0) return [item];
    const deleted = evidence.filter(alias => context.evidenceStatus(alias) === 'deleted');
    if (deleted.length === 0) return [item];
    const system = { actor: 'system' as const, reason: 'evidence_deleted', intent: 'sweep' as const };
    if (deleted.length === evidence.length) {
      records.push(base({ ...system, op: 'remove', before: serializeEntry(item.entry) }));
      return [];
    }
    const pruned: MemoryEntry = { ...item.entry, evidence: evidence.filter(alias => !deleted.includes(alias)) };
    records.push(base({ ...system, op: 'replace', before: serializeEntry(item.entry), after: serializeEntry(pruned) }));
    return [{ entry: pruned }];
  });
  const sweptBody = bodyChars(working.map(item => item.entry));
  const entriesOf = (): MemoryEntry[] => working.map(item => item.entry);

  // Net size change of plain (owner-evidenced) material in this batch: the only
  // room owner facts may claim by evicting older owner facts.
  let ownerGrowth = 0;

  const applyOp = (op: RawMemoryOp, record: MemoryOpRecord): string | undefined => {
    if ((op.intent === 'add') !== (op.op === 'add')) return 'intent_op_mismatch';
    const text = op.text;
    const oldText = op.old_text;
    if (op.op === 'remove' ? text !== undefined : text === undefined) return 'bad_shape';
    if (op.op === 'add' ? oldText !== undefined : oldText === undefined) return 'bad_shape';
    if (text !== undefined) {
      if (text.length < 1 || text.length > MAX_TEXT_CHARS || /[\r\n§]/.test(text) || text.trim() === '') return 'bad_text';
      // The code writes the date and the aliases; a model that pastes them in
      // would get them twice.
      if (/^\s*-\s*\[/.test(text)) return 'bad_text';
    }
    if (oldText !== undefined && (oldText.length < MIN_OLD_TEXT_CHARS || oldText.length > MAX_OLD_TEXT_CHARS)) return 'bad_old_text';

    const ids = [...new Set((op.evidence ?? []).map(id => id.trim()).filter(id => id !== ''))].slice(0, MAX_EVIDENCE_PER_ENTRY);
    if (ids.length === 0) return 'evidence_missing';
    const cited: WindowMessage[] = [];
    for (const id of ids) {
      const message = window.messages.get(id);
      if (!message) return 'evidence_unknown';
      if (message.deleted) return 'evidence_deleted';
      if (message.blocked || message.kind === 'bot' || message.kind === 'unknown') return 'evidence_not_citable';
      if (!cited.includes(message)) cited.push(message);
    }

    let targetIndex = -1;
    if (oldText !== undefined) {
      const match = findEntryByText(entriesOf(), oldText);
      if (match.kind === 'not_found') return 'not_found';
      if (match.kind === 'ambiguous') return 'ambiguous_match';
      targetIndex = match.index;
    }
    const target = targetIndex >= 0 ? working[targetIndex]!.entry : undefined;
    if (target && op.intent === 'owner' && isHearsay(target)) return 'intent_target_mismatch';
    if (target && op.intent === 'supersede' && !isHearsay(target)) return 'intent_target_mismatch';

    // On a person card the owner is the person; SELF.md has no owner, any
    // in-window evidence will do.
    const ownerEvidence = uid !== undefined && cited.some(message => message.kind === 'human' && message.senderId === uid);
    if (op.intent === 'owner' && uid !== undefined && !ownerEvidence) return 'owner_evidence_missing';

    let hearsayText = false;
    if (text !== undefined) {
      hearsayText = isHearsayText(text);
      if (isSelf) {
        if (hearsayText) return 'hearsay_on_self';
      } else {
        // Third-party material can only enter as hearsay.
        if (!ownerEvidence && !hearsayText) return 'hearsay_prefix_missing';
        if (op.intent === 'owner' && hearsayText) return 'owner_text_hearsay';
      }
      const normalized = normalizeText(text);
      if (target && normalized === normalizeText(target.text)) return 'duplicate';
      if (isDuplicateText(entriesOf(), text, targetIndex >= 0 ? targetIndex : undefined)) return 'duplicate';
      if (uid !== undefined) {
        // Either direction: a text that contains a forgotten fact re-adds it.
        const needle = withoutPrefix(text);
        const forgotten = context.forgets.some(forget => {
          if (forget.uid !== uid) return false;
          const old = withoutPrefix(forget.text);
          return old !== '' && (old.includes(needle) || needle.includes(old));
        });
        if (forgotten) return 'recently_forgotten';
      }
      const verdict = scanMemoryText(text, { allowUrls: !isSelf && !hearsayText });
      if (!verdict.ok) {
        record.detail = verdict.reason;
        return 'scan';
      }
    }

    const newest = newestMessage(cited);
    const displayIds = cited.map(message => message.displayId);
    record.evidence = displayIds;
    record.canonicalIds = cited.map(message => message.canonicalId);
    if (newest.senderId) record.speakerUid = ownerEvidence && uid ? uid : newest.senderId;

    if (op.op === 'remove') {
      const removed = working.splice(targetIndex, 1)[0]!;
      record.before = serializeEntry(removed.entry);
      if (!isHearsay(removed.entry)) ownerGrowth -= entryChars(removed.entry);
      // A removal backed by the owner's own message is a forget request that must
      // stay forgotten, whatever the intent: "别记这个" about a hearsay entry goes
      // through `supersede`. Stored without the hearsay prefix so both forms match.
      if (uid !== undefined && ownerEvidence)
        forgets.push({ at: context.atMs, uid, text: withoutPrefix(removed.entry.text), canonicalIds: record.canonicalIds });
      return undefined;
    }

    // A rewrite keeps what the old entry cited; only the new citations had to be
    // in the window.
    const evidence = [...new Set([...(target?.evidence ?? []), ...displayIds])].slice(-MAX_EVIDENCE_PER_ENTRY);
    const entry: MemoryEntry = { date: localDate(newest.timestampSec, newest.utcOffsetMin), evidence, text: text! };
    record.after = serializeEntry(entry);
    if (target) record.before = serializeEntry(target);
    if (!hearsayText) ownerGrowth += entryChars(entry) - (target && !isHearsay(target) ? entryChars(target) : 0);
    if (target) working[targetIndex] = { entry, origin: { record, kind: 'replace', before: target } };
    else working.push({ entry, origin: { record, kind: 'add' } });
    return undefined;
  };

  for (const op of ops) {
    const record = base({
      op: op.op,
      intent: op.intent,
      ...(op.text !== undefined ? { text: op.text } : {}),
      ...(op.old_text !== undefined ? { oldText: op.old_text } : {}),
      ...(op.reason ? { reason: op.reason } : {}),
    });
    const why = applyOp(op, record);
    if (why) {
      record.outcome = 'rejected';
      record.why = why;
      // A rejected op never touched the file; claim only what the model cited.
      if (!record.evidence && op.evidence) record.evidence = op.evidence;
    }
    records.push(record);
  }

  const evictions: MemoryOpRecord[] = [];
  // Drop one entry that is leaving automatically. An entry this batch added is
  // not evicted after the fact: its op is rejected instead.
  const drop = (item: WorkEntry, reason: string): void => {
    working = working.filter(candidate => candidate !== item);
    if (item.origin) {
      // Nothing of this op reaches the disk. A dropped replacement takes the entry
      // it was meant to replace with it, and that is what the audit shows leaving.
      item.origin.record.outcome = 'rejected';
      item.origin.record.why = reason;
      if (item.origin.kind === 'add') return;
      delete item.origin.record.after;
      evictions.push(base({ op: 'remove', intent: 'evict', before: serializeEntry(item.origin.before!), reason }));
      return;
    }
    evictions.push(base({ op: 'remove', intent: 'evict', before: serializeEntry(item.entry), reason }));
  };
  const oldestFirst = (predicate: (item: WorkEntry) => boolean): WorkEntry[] =>
    working
      .map((item, index) => ({ entry: item.entry, index, item }))
      .filter(candidate => predicate(candidate.item))
      .sort(byAge)
      .map(candidate => candidate.item);

  // Hearsay cap first: it never rejects the file, it sheds the oldest hearsay.
  const overHearsayCap = (): boolean => {
    const stats = hearsayStats(entriesOf());
    return stats.count > config.hearsayMaxEntries || stats.chars > config.hearsayMaxChars;
  };
  for (const item of oldestFirst(candidate => isHearsay(candidate.entry))) {
    if (!overHearsayCap()) break;
    drop(item, 'hearsay_cap');
  }

  // The batch never grows a file past its budget; an already oversized file
  // (hand edit) may stay as large as it was but not larger.
  const limit = Math.max(budget, sweptBody);
  const size = (): number => bodyChars(entriesOf());
  // Hearsay leaves first, so third-party material can never push out an owner fact.
  for (const item of oldestFirst(candidate => isHearsay(candidate.entry))) {
    if (size() <= limit) break;
    drop(item, 'over_budget');
  }
  // Owner facts only make room for owner facts written in this same batch.
  let allowance = Math.max(0, ownerGrowth);
  for (const item of oldestFirst(candidate => !isHearsay(candidate.entry) && candidate.origin === undefined)) {
    if (size() <= limit || allowance <= 0) break;
    allowance -= entryChars(item.entry);
    drop(item, 'over_budget');
  }

  if (size() > limit) {
    for (const record of records) {
      if (record.outcome === 'applied') {
        record.outcome = 'rejected';
        record.why = 'over_budget';
      }
    }
    return { path, baseHash: state.hash, next: null, records, forgets: [], hadOps: ops.length > 0, rejected: true };
  }
  records.push(...evictions);

  const finalEntries = entriesOf();
  const unchanged = finalEntries.length === initialEntries.length
    && finalEntries.every((entry, index) => serializeEntry(entry) === serializeEntry(initialEntries[index]!));
  const speaker = uid === undefined ? undefined : window.speakers.find(candidate => candidate.uid === uid);
  const header = state.status === 'missing' ? defaultHeader(path, speaker?.displayName) : refreshHeader(state.header, path, speaker?.displayName);
  return {
    path,
    baseHash: state.hash,
    next: unchanged ? null : { header, entries: finalEntries },
    records,
    forgets,
    hadOps: ops.length > 0,
    rejected: false,
  };
};
