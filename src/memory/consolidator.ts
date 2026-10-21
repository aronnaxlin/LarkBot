import type { Logger } from '@guiiai/logg';

import { isValidMemoryId, localDate } from './format';
import { parseModelOutput, parseOps, planFile } from './ops';
import type { EvidenceStatus, FilePlan, RawMemoryOp } from './ops';
import { renderMemoryState } from './prompt';
import { HEARSAY_PREFIX, personPath, SELF_PATH } from './types';
import type { MemoryBackend, MemoryConfig, MemoryFileState, MemoryOpRecord, MemoryPath } from './types';
import type { MemoryWindow } from './window';
import { renderMemorySystemPrompt, renderMemoryUserInstruction } from '../driver/prompt';
import { callLlm } from '../llm/call';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry, InputMessage, OutputMessage } from '../unified-api/types';

// Fewer human messages than this carry nothing worth a model call. The
// compaction trigger can fire on a quiet window; the cursor still advances.
export const MIN_WINDOW_HUMAN_MESSAGES = 5;
// Most active speakers whose cards are offered per run: bounds the prompt.
export const MAX_SPEAKERS_PER_RUN = 12;

export interface ConsolidatorDeps {
  backend: MemoryBackend;
  // Window over the persisted archive from the memory cursor. Never starts at
  // the compaction cursor.
  buildWindow: (chatId: string, fromMs: number, blockedUserIds: ReadonlySet<string>, maxWindowMessages: number) => MemoryWindow;
  // Deletion status of evidence aliases, including messages outside the window.
  resolveEvidence: (chatId: string, aliases: readonly string[]) => Map<string, EvidenceStatus>;
}

/**
 * The model's output failed validation. Unlike a provider error this reproduces
 * itself on the same window, which is why the controller counts it separately
 * and eventually skips the window.
 */
export class MemoryValidationError extends Error {
  constructor(readonly why: string, readonly fromMs: number, readonly endMs: number) {
    super(`Memory output failed validation: ${why}`);
    this.name = 'MemoryValidationError';
  }
}

export interface ConsolidationResult {
  kind: 'skipped' | 'applied';
  fromMs: number;
  // The cursor moves here after a successful run.
  endMs: number;
  humanMessages: number;
  truncated: boolean;
  opsApplied: number;
  opsRejected: number;
}

const assistantText = (entries: ConversationEntry[]): string => {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of (entry as OutputMessage).parts) {
      if (part.kind === 'text') parts.push(part.text);
      else if (part.kind === 'textGroup') for (const text of part.content) parts.push(text.text);
    }
  }
  return parts.join('');
};

const isWritable = (state: MemoryFileState): state is Extract<MemoryFileState, { status: 'ok' | 'missing' }> =>
  state.status !== 'malformed';

export const runConsolidation = async (params: {
  chatId: string;
  fromMs: number;
  config: MemoryConfig;
  endpoint: LlmEndpoint;
  blockedUserIds: ReadonlySet<string>;
  deps: ConsolidatorDeps;
  log: Logger;
  now?: () => number;
}): Promise<ConsolidationResult> => {
  const { chatId, fromMs, config, deps, log } = params;
  const now = params.now ?? Date.now;
  const window = deps.buildWindow(chatId, fromMs, params.blockedUserIds, config.maxWindowMessages);
  const summary = { fromMs, endMs: window.endMs, humanMessages: window.humanMessageCount, truncated: window.truncated };

  if (window.truncated)
    log.withFields({ chatId, fromMs, humanMessages: window.humanMessageCount }).warn('Memory window truncated to the newest messages; older ones since the cursor are skipped');
  // Ids that cannot be a file name have no card.
  const speakers = window.speakers.filter(speaker => isValidMemoryId(speaker.uid)).slice(0, MAX_SPEAKERS_PER_RUN);
  if (window.humanMessageCount < MIN_WINDOW_HUMAN_MESSAGES || speakers.length === 0)
    return { kind: 'skipped', ...summary, opsApplied: 0, opsRejected: 0 };

  const atMs = now();
  const paths: MemoryPath[] = [SELF_PATH, ...speakers.map(speaker => personPath(speaker.uid))];
  const states = new Map<MemoryPath, Extract<MemoryFileState, { status: 'ok' | 'missing' }>>();
  for (const path of paths) {
    const state = params.deps.backend.loadFile(chatId, path);
    if (isWritable(state)) {
      states.set(path, state);
      continue;
    }
    log.withFields({ chatId, path, error: state.error }).error('Memory file is malformed; it is left untouched until fixed by hand');
  }
  if (states.size === 0) throw new Error('Every memory file offered for this run is malformed');

  const statuses = deps.resolveEvidence(chatId, [...new Set([...states.values()].flatMap(state => state.entries.flatMap(entry => entry.evidence)))]);
  const evidenceStatus = (alias: string): EvidenceStatus => statuses.get(alias) ?? 'unknown';
  const forgets = params.deps.backend.readRecentForgets(chatId, config.doNotReadd);

  const [system, instruction] = await Promise.all([
    renderMemorySystemPrompt({
      cardMaxChars: config.cardMaxChars,
      selfMaxChars: config.selfMaxChars,
      hearsayMaxEntries: config.hearsayMaxEntries,
      hearsayMaxChars: config.hearsayMaxChars,
      hearsayPrefix: HEARSAY_PREFIX,
    }),
    renderMemoryUserInstruction({ currentDate: localDate(Math.floor(atMs / 1000), -new Date(atMs).getTimezoneOffset()) }),
  ]);
  const state = renderMemoryState({
    config,
    speakers,
    files: [...states.values()].map(item => ({ path: item.path, entries: item.entries })),
    forgets,
  });
  const entries: ConversationEntry[] = [{
    kind: 'message',
    role: 'user',
    parts: [
      { kind: 'text', text: `<chatlog>\n${window.xml}\n</chatlog>` },
      { kind: 'text', text: `${state}\n\n${instruction}` },
    ],
  } satisfies InputMessage];

  const { endpoint } = params;
  const result = await callLlm({
    apiBaseUrl: endpoint.apiBaseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    apiFormat: endpoint.apiFormat,
    timeoutSec: endpoint.timeoutSec,
    extraBody: endpoint.extraBody,
  }, entries, system, undefined, {
    log,
    label: `memory:${chatId}`,
    dumpId: `${chatId}.memory`,
    maxImagesAllowed: endpoint.maxImagesAllowed,
  });
  log.withFields({
    chatId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    humanMessages: window.humanMessageCount,
  }).log('Memory model call finished');

  const text = assistantText(result.entries).trim();
  if (text === '') throw new MemoryValidationError('empty_output', fromMs, window.endMs);
  const output = parseModelOutput(text);
  if (!output.ok) throw new MemoryValidationError(output.why, fromMs, window.endMs);

  const parsed = parseOps(output.ops);
  const base = {
    at: atMs, chatId, outcome: 'rejected' as const, actor: 'consolidator' as const,
    model: endpoint.model, cursorAfterMs: window.endMs,
  };
  const loose: MemoryOpRecord[] = [];
  for (const invalid of parsed.invalid)
    loose.push({ ...base, file: invalid.path, op: 'add', intent: 'add', why: 'bad_shape', text: invalid.raw });

  const opsByPath = new Map<MemoryPath, RawMemoryOp[]>();
  for (const op of parsed.valid) {
    const path = op.path as MemoryPath;
    if (!states.has(path)) {
      loose.push({
        ...base, file: op.path, op: op.op, intent: op.intent, why: 'path_not_writable',
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.old_text !== undefined ? { oldText: op.old_text } : {}),
        ...(op.evidence ? { evidence: op.evidence } : {}),
      });
      continue;
    }
    opsByPath.set(path, [...(opsByPath.get(path) ?? []), op]);
  }

  const planContext = { chatId, window, config, model: endpoint.model, atMs, forgets, evidenceStatus };
  const plans: FilePlan[] = [...states.entries()].map(([path, fileState]) =>
    planFile(path, fileState, opsByPath.get(path) ?? [], planContext));
  deps.backend.appendOps(chatId, loose);
  const applied = deps.backend.applyBatch(chatId, plans.map(plan => ({
    path: plan.path,
    baseHash: plan.baseHash,
    next: plan.next,
    records: plan.records,
    forgets: plan.forgets,
  })), { doNotReadd: config.doNotReadd });

  const allRecords = plans.flatMap(plan => plan.records);
  const opsApplied = allRecords.filter(record => record.outcome === 'applied' && record.actor === 'consolidator' && record.intent !== 'evict').length;
  const opsRejected = allRecords.filter(record => record.outcome === 'rejected').length + loose.length;
  log.withFields({ chatId, opsApplied, opsRejected, files: applied.files.map(file => `${file.path}:${file.status}`) }).log('Memory batch applied');

  // The cursor must not move past work that was dropped: a hand edit raced the
  // write, so the same window is replayed (the duplicate rule makes it harmless).
  const conflicts = applied.files.filter(file => file.status === 'conflict');
  if (conflicts.length > 0) throw new Error(`Memory file changed on disk during the run: ${conflicts.map(file => file.path).join(', ')}`);
  const withOps = plans.filter(plan => plan.hadOps);
  if (withOps.length > 0 && withOps.every(plan => plan.rejected))
    throw new MemoryValidationError('every_file_rejected', fromMs, window.endMs);

  return { kind: 'applied', ...summary, opsApplied, opsRejected };
};
