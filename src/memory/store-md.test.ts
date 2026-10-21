import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serializeFile } from './format';
import { createMarkdownMemoryStore } from './store-md';
import type { ForgetRecord, MemoryFileBatch, MemoryOpRecord } from './types';

initLogger(LogLevel.Error, Format.Pretty);

const CHAT = 'oc_chat';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'memory-store-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = () => createMarkdownMemoryStore({ rootDir: root, logger: useLogger('memory-store-test') });
const record = (extra: Partial<MemoryOpRecord> = {}): MemoryOpRecord =>
  ({ at: 1, chatId: CHAT, file: 'people/ou_a.md', outcome: 'applied', op: 'add', intent: 'add', actor: 'consolidator', ...extra });
const content = { header: '# 阿龙 (ou_a)', entries: [{ date: '2026-10-20', evidence: ['m1'], text: '住在深圳' }] };
const forget = (text: string): ForgetRecord => ({ at: 1, uid: 'ou_a', text, canonicalIds: [] });
const batch = (extra: Partial<MemoryFileBatch> = {}): MemoryFileBatch =>
  ({ path: 'people/ou_a.md', baseHash: null, next: content, records: [record()], forgets: [], ...extra });
const ops = () => readFileSync(join(root, CHAT, 'ops.jsonl'), 'utf-8').trim().split('\n').map(line => JSON.parse(line) as MemoryOpRecord);

describe('markdown memory store', () => {
  it('reports a missing file as an empty shell and writes through a temp file', () => {
    const backend = store();
    expect(backend.loadFile(CHAT, 'people/ou_a.md')).toMatchObject({ status: 'missing', hash: null, entries: [] });
    expect(backend.readCards(CHAT, ['ou_a'])).toEqual([{ path: 'people/ou_a.md', uid: 'ou_a', entries: [] }]);
    expect(backend.applyBatch(CHAT, [batch()], { doNotReadd: 20 }).files).toEqual([{ path: 'people/ou_a.md', status: 'written' }]);
    const dir = join(root, CHAT, 'people');
    expect(readdirSync(dir)).toEqual(['ou_a.md']);
    expect(readFileSync(join(dir, 'ou_a.md'), 'utf-8')).toBe(serializeFile(content));
    expect(backend.readCards(CHAT, ['ou_a'])[0]).toMatchObject({ displayName: '阿龙', entries: content.entries });
  });

  it('appends one ops.jsonl line per record, after the write', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch({ records: [record(), record({ outcome: 'rejected', why: 'duplicate' })] })], { doNotReadd: 20 });
    expect(ops().map(line => line.outcome)).toEqual(['applied', 'rejected']);
    backend.appendOps(CHAT, [record({ file: 'people/ou_zzz.md', outcome: 'rejected', why: 'path_not_writable' })]);
    expect(ops()).toHaveLength(3);
  });

  it('does not rewrite an unchanged file and appends only audit lines', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch()], { doNotReadd: 20 });
    const hash = (backend.loadFile(CHAT, 'people/ou_a.md') as { hash: string }).hash;
    const result = backend.applyBatch(CHAT, [batch({ baseHash: hash, next: null, records: [record({ outcome: 'rejected', why: 'duplicate' })] })], { doNotReadd: 20 });
    expect(result.files[0]?.status).toBe('unchanged');
    expect(ops()).toHaveLength(2);
  });

  it('uses a hand-edited file as authoritative and canonicalizes it only on a real change', () => {
    const backend = store();
    mkdirSync(join(root, CHAT, 'people'), { recursive: true });
    const path = join(root, CHAT, 'people', 'ou_a.md');
    writeFileSync(path, '# 阿龙 (ou_a)\n\n\n- [2026-10-20] [m1] 手改的事实\n\n\n- [2026-10-21] 手写，无证据\n');
    const state = backend.loadFile(CHAT, 'people/ou_a.md');
    expect(state).toMatchObject({ status: 'ok', drift: true });
    expect(backend.readCards(CHAT, ['ou_a'])[0]?.entries.map(entry => entry.text)).toEqual(['手改的事实', '手写，无证据']);
    // unchanged plan: bytes stay exactly as the maintainer left them
    const before = readFileSync(path, 'utf-8');
    backend.applyBatch(CHAT, [batch({ baseHash: (state as { hash: string }).hash, next: null, records: [] })], { doNotReadd: 20 });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('refuses a malformed file and never overwrites it', () => {
    const backend = store();
    mkdirSync(join(root, CHAT, 'people'), { recursive: true });
    const path = join(root, CHAT, 'people', 'ou_a.md');
    writeFileSync(path, 'oops, someone wrote prose here\n');
    expect(backend.loadFile(CHAT, 'people/ou_a.md')).toMatchObject({ status: 'malformed' });
    expect(backend.readCards(CHAT, ['ou_a'])[0]?.entries).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe('oops, someone wrote prose here\n');
  });

  it('drops a file\'s operations when its content changed after it was read', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch()], { doNotReadd: 20 });
    const stale = (backend.loadFile(CHAT, 'people/ou_a.md') as { hash: string }).hash;
    const path = join(root, CHAT, 'people', 'ou_a.md');
    writeFileSync(path, `${readFileSync(path, 'utf-8')}§\n- [2026-10-22] 维护者手加的\n`);
    const edited = readFileSync(path, 'utf-8');
    const result = backend.applyBatch(CHAT, [batch({ baseHash: stale, next: { header: '# x', entries: [] }, records: [record()] })], { doNotReadd: 20 });
    expect(result.files).toEqual([{ path: 'people/ou_a.md', status: 'conflict' }]);
    expect(readFileSync(path, 'utf-8')).toBe(edited);
    expect(ops().at(-1)).toMatchObject({ outcome: 'rejected', why: 'file_changed' });
  });

  it('treats a file that appeared since it was read as a conflict too', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch()], { doNotReadd: 20 });
    expect(backend.applyBatch(CHAT, [batch({ baseHash: null })], { doNotReadd: 20 }).files[0]?.status).toBe('conflict');
  });

  it('keeps forgets.jsonl at the newest doNotReadd lines and reads it after ops.jsonl is rotated away', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch({ forgets: [forget('一'), forget('二'), forget('三')] })], { doNotReadd: 2 });
    expect(backend.readRecentForgets(CHAT, 10).map(item => item.text)).toEqual(['二', '三']);
    const hash = (backend.loadFile(CHAT, 'people/ou_a.md') as { hash: string }).hash;
    renameSync(join(root, CHAT, 'ops.jsonl'), join(root, CHAT, 'ops.jsonl.rotated'));
    backend.applyBatch(CHAT, [batch({ baseHash: hash, next: { ...content, entries: [] }, forgets: [forget('四')] })], { doNotReadd: 2 });
    expect(backend.readRecentForgets(CHAT, 10).map(item => item.text)).toEqual(['三', '四']);
    expect(backend.readRecentForgets(CHAT, 1).map(item => item.text)).toEqual(['四']);
    expect(readdirSync(join(root, CHAT)).sort()).toEqual(['forgets.jsonl', 'ops.jsonl', 'ops.jsonl.rotated', 'people'].sort());
  });

  it('validates chat and person ids before building any path', () => {
    const backend = store();
    expect(() => backend.readCards('../etc', ['ou_a'])).toThrow('Invalid memory chat id');
    expect(() => backend.readCards(CHAT, ['../../x'])).toThrow('Invalid memory person id');
    expect(() => backend.loadFile(CHAT, 'people/../x.md' as 'SELF.md')).toThrow('Invalid memory path');
  });

  it('keeps chats apart', () => {
    const backend = store();
    backend.applyBatch(CHAT, [batch()], { doNotReadd: 20 });
    expect(backend.readCards('oc_other', ['ou_a'])[0]?.entries).toEqual([]);
  });
});
