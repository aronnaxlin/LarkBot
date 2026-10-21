import type { LlmEndpoint } from '../llm/types';

// Prefix that marks an entry as third-party material about the card owner. The
// validator derives the class of an entry from this prefix alone.
export const HEARSAY_PREFIX = '群里的说法：';

export const SELF_PATH = 'SELF.md';
export type MemoryPath = typeof SELF_PATH | `people/${string}.md`;

// Platform ids that become file names: Feishu `oc_...`/`ou_...` and numeric
// Telegram ids (supergroup ids carry a leading `-`).
export const MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const personPath = (uid: string): MemoryPath => `people/${uid}.md`;

/** `people/<uid>.md` -> uid; undefined for SELF.md and anything else. */
export const uidFromPath = (path: string): string | undefined => {
  const match = /^people\/([A-Za-z0-9_-]{1,64})\.md$/.exec(path);
  return match?.[1];
};

export interface MemoryConfig {
  enabled: boolean;
  // false = write cards but inject nothing (shadow mode).
  inject: boolean;
  // Omitted -> compaction.model -> primary.model, resolved by the driver wiring.
  model?: LlmEndpoint;
  triggerMessages: number;
  maxWindowMessages: number;
  cardMaxChars: number;
  selfMaxChars: number;
  hearsayMaxEntries: number;
  hearsayMaxChars: number;
  injectionMaxChars: number;
  selfInjectionChars: number;
  lookbackMessages: number;
  recentSpeakers: number;
  doNotReadd: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  inject: true,
  triggerMessages: 40,
  maxWindowMessages: 200,
  cardMaxChars: 1200,
  selfMaxChars: 1000,
  hearsayMaxEntries: 3,
  hearsayMaxChars: 500,
  injectionMaxChars: 4000,
  selfInjectionChars: 800,
  lookbackMessages: 30,
  recentSpeakers: 4,
  doNotReadd: 20,
};

export interface MemoryEntry {
  // Local date (YYYY-MM-DD) of the newest cited message.
  date: string;
  // Rendered message ids exactly as the chatlog shows them. Empty only for
  // entries a maintainer wrote by hand.
  evidence: string[];
  text: string;
}

export interface MemoryFileContent {
  header: string;
  entries: MemoryEntry[];
}

export interface MemoryCard {
  path: MemoryPath;
  uid?: string;
  displayName?: string;
  entries: MemoryEntry[];
}

export type MemoryFileState =
  | { status: 'missing'; path: MemoryPath; hash: null; header: string; entries: MemoryEntry[] }
  | { status: 'ok'; path: MemoryPath; hash: string; header: string; entries: MemoryEntry[]; drift: boolean }
  | { status: 'malformed'; path: MemoryPath; hash: string; error: string };

export type MemoryOutcome = 'applied' | 'rejected';

// One line of ops.jsonl. `before`/`after` carry the whole serialized entry.
export interface MemoryOpRecord {
  at: number;
  chatId: string;
  file: string;
  outcome: MemoryOutcome;
  op: 'add' | 'replace' | 'remove';
  intent: 'add' | 'owner' | 'supersede' | 'evict' | 'sweep';
  why?: string;
  // Extra context for `why` (the scan pattern that matched).
  detail?: string;
  before?: string;
  after?: string;
  text?: string;
  oldText?: string;
  evidence?: string[];
  canonicalIds?: string[];
  speakerUid?: string;
  reason?: string;
  actor: 'consolidator' | 'system';
  model?: string;
  cursorAfterMs?: number;
}

// One line of forgets.jsonl: an owner-initiated removal that must stay removed.
export interface ForgetRecord {
  at: number;
  uid: string;
  text: string;
  canonicalIds: string[];
}

export interface MemoryFileBatch {
  path: MemoryPath;
  // Hash of the bytes the plan was computed from; null = the file was absent.
  baseHash: string | null;
  // null = leave the file alone (the records are still appended).
  next: MemoryFileContent | null;
  records: MemoryOpRecord[];
  forgets: ForgetRecord[];
}

export interface MemoryApplyResult {
  files: { path: MemoryPath; status: 'written' | 'unchanged' | 'conflict' }[];
}

// The writer's Markdown store is one implementation; a Mem0 or Hy-Memory
// sidecar could implement the same methods without the driver noticing.
export interface MemoryBackend {
  // Missing or malformed files come back as empty shells.
  readCards: (chatId: string, uids: readonly string[]) => MemoryCard[];
  readSelf: (chatId: string) => MemoryCard;
  // Writer-side read: carries the content hash and the drift flag.
  loadFile: (chatId: string, path: MemoryPath) => MemoryFileState;
  // The only writer. All-or-nothing per file; a changed hash drops that file.
  applyBatch: (chatId: string, batch: MemoryFileBatch[], options: { doNotReadd: number }) => MemoryApplyResult;
  // Audit lines that belong to no file write (ops on unwritable paths, malformed files).
  appendOps: (chatId: string, records: MemoryOpRecord[]) => void;
  // Newest `owner` removals from forgets.jsonl, for the do-not-readd list.
  readRecentForgets: (chatId: string, limit: number) => ForgetRecord[];
}
