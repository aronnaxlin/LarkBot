import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { Logger } from '@guiiai/logg';

import { defaultHeader, isValidMemoryId, nameFromHeader, parseFile, serializeFile } from './format';
import { SELF_PATH, uidFromPath } from './types';
import type {
  ForgetRecord,
  MemoryApplyResult,
  MemoryBackend,
  MemoryCard,
  MemoryFileState,
  MemoryOpRecord,
  MemoryPath,
} from './types';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

const readIfExists = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

// Cross-process mutual exclusion for the shared jsonl files: a second process on
// the same volume must not interleave an append with a rewrite. Within one
// process the per-chat controller already serializes writers.
const withFileLock = <T>(path: string, run: () => T): T => {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch (statError) {
        if (!isNotFound(statError)) throw statError;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on ${path}`);
      sleepSync(20);
    }
  }
  try {
    return run();
  } finally {
    rmSync(lockPath, { force: true });
  }
};

// Temp file in the same directory + rename: readers see the old or the new
// file, never a partial one.
const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
};

export const createMarkdownMemoryStore = (deps: { rootDir: string; logger: Logger }): MemoryBackend => {
  const log = deps.logger.withContext('memory-store');
  // A malformed or drifted file is reported once per content hash, not on every
  // wake-up that reads it.
  const reportedMalformed = new Set<string>();
  const reportedDrift = new Set<string>();

  const chatDir = (chatId: string): string => {
    if (!isValidMemoryId(chatId)) throw new Error(`Invalid memory chat id "${chatId}"`);
    return join(deps.rootDir, chatId);
  };

  const filePath = (chatId: string, path: MemoryPath): string => {
    const uid = uidFromPath(path);
    if (path !== SELF_PATH && uid === undefined) throw new Error(`Invalid memory path "${path}"`);
    return join(chatDir(chatId), path);
  };

  const emptyShell = (path: MemoryPath, header?: string): { header: string; entries: [] } =>
    ({ header: header ?? defaultHeader(path), entries: [] });

  const loadFile = (chatId: string, path: MemoryPath): MemoryFileState => {
    const bytes = readIfExists(filePath(chatId, path));
    if (bytes === null) return { status: 'missing', path, hash: null, ...emptyShell(path) };
    const hash = sha256(bytes);
    const parsed = parseFile(bytes);
    if (!parsed.ok) return { status: 'malformed', path, hash, error: parsed.error };
    const drift = serializeFile(parsed.file) !== bytes;
    if (drift && !reportedDrift.has(`${chatId}/${path}/${hash}`)) {
      reportedDrift.add(`${chatId}/${path}/${hash}`);
      log.withFields({ chatId, path }).warn('Memory file does not round-trip; the on-disk entries are used and it is rewritten canonically on the next change');
    }
    return { status: 'ok', path, hash, header: parsed.file.header, entries: parsed.file.entries, drift };
  };

  const readCard = (chatId: string, path: MemoryPath): MemoryCard => {
    const uid = uidFromPath(path);
    const state = loadFile(chatId, path);
    if (state.status === 'malformed') {
      const key = `${chatId}/${path}/${state.hash}`;
      if (!reportedMalformed.has(key)) {
        reportedMalformed.add(key);
        log.withFields({ chatId, path, error: state.error }).error('Memory file is malformed and is ignored until fixed by hand');
      }
      return { path, ...(uid ? { uid } : {}), entries: [] };
    }
    const displayName = uid ? nameFromHeader(state.header, uid) : undefined;
    return { path, ...(uid ? { uid } : {}), ...(displayName ? { displayName } : {}), entries: state.entries };
  };

  const readCards = (chatId: string, uids: readonly string[]): MemoryCard[] =>
    uids.map(uid => {
      if (!isValidMemoryId(uid)) throw new Error(`Invalid memory person id "${uid}"`);
      return readCard(chatId, `people/${uid}.md`);
    });

  const readSelf = (chatId: string): MemoryCard => readCard(chatId, SELF_PATH);

  const appendOps = (chatId: string, records: MemoryOpRecord[]): void => {
    if (records.length === 0) return;
    const path = join(chatDir(chatId), 'ops.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    const lines = records.map(record => `${JSON.stringify(record)}\n`).join('');
    // One write per call under O_APPEND; the lock keeps another process out.
    withFileLock(path, () => appendFileSync(path, lines));
  };

  const parseForgets = (chatId: string, bytes: string | null): ForgetRecord[] => {
    if (bytes === null) return [];
    const records: ForgetRecord[] = [];
    for (const line of bytes.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const value = JSON.parse(line) as Partial<ForgetRecord>;
        if (typeof value.uid === 'string' && typeof value.text === 'string' && typeof value.at === 'number')
          records.push({ at: value.at, uid: value.uid, text: value.text, canonicalIds: Array.isArray(value.canonicalIds) ? value.canonicalIds : [] });
      } catch {
        log.withFields({ chatId }).warn('Skipping an unreadable forgets.jsonl line');
      }
    }
    return records;
  };

  const readRecentForgets = (chatId: string, limit: number): ForgetRecord[] => {
    if (limit <= 0) return [];
    const bytes = readIfExists(join(chatDir(chatId), 'forgets.jsonl'));
    return parseForgets(chatId, bytes).slice(-limit);
  };

  // The file is its own size bound: trimmed to the newest `keep` lines on every
  // append, so it cannot grow into a second audit log.
  const appendForgets = (chatId: string, records: ForgetRecord[], keep: number): void => {
    if (records.length === 0) return;
    const path = join(chatDir(chatId), 'forgets.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    withFileLock(path, () => {
      const merged = [...parseForgets(chatId, readIfExists(path)), ...records];
      const kept = keep > 0 ? merged.slice(-keep) : [];
      writeAtomic(path, kept.map(record => `${JSON.stringify(record)}\n`).join(''));
    });
  };

  const applyBatch: MemoryBackend['applyBatch'] = (chatId, batch, options) => {
    const result: MemoryApplyResult = { files: [] };
    for (const item of batch) {
      const target = filePath(chatId, item.path);
      const currentBytes = readIfExists(target);
      const currentHash = currentBytes === null ? null : sha256(currentBytes);
      if (currentHash !== item.baseHash) {
        // Edited by hand since the plan was made: drop this file's ops and let
        // the next trigger redo them against the new content.
        log.withFields({ chatId, path: item.path }).warn('Memory file changed on disk since it was read; its operations are dropped and retried on the next run');
        appendOps(chatId, item.records.map((record): MemoryOpRecord => ({ ...record, outcome: 'rejected', why: 'file_changed' })));
        result.files.push({ path: item.path, status: 'conflict' });
        continue;
      }
      let status: 'written' | 'unchanged' = 'unchanged';
      if (item.next) {
        const next = serializeFile(item.next);
        if (next !== currentBytes) {
          writeAtomic(target, next);
          status = 'written';
        }
      }
      // Content first, audit second: disk is never ahead of what it can explain
      // except by one batch of missing audit lines after a crash.
      appendOps(chatId, item.records);
      if (status === 'written') appendForgets(chatId, item.forgets, options.doNotReadd);
      result.files.push({ path: item.path, status });
    }
    return result;
  };

  return { readCards, readSelf, loadFile, applyBatch, appendOps, readRecentForgets };
};
