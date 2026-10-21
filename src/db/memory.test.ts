import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, runMigrations } from './client';
import type { DB } from './client';
import { countHumanMessagesQuery, countHumanMessagesSince, findHumanWindowStart, loadDeletedMessageIds, loadMemoryCursor, persistMemoryRun } from './memory';
import { persistEvent } from './persistence';
import * as schema from './schema';
import type { CanonicalUser } from '../adaptation/types';
import type { PipelineEvent } from '../projection';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('memory-db-test');

const BOT = 'ou_bot';
const person = (id: string, isBot = false): CanonicalUser => ({ id, displayName: id, isBot });

let directory: string;
let dbPath: string;
const opened: DB[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-db-'));
  dbPath = join(directory, 'test.db');
});
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

const open = (): DB => {
  const db = createDatabase(dbPath, logger);
  opened.push(db);
  return db;
};

const message = (id: string, sender: CanonicalUser | undefined, receivedAtMs: number, extra: { selfSent?: boolean; chatId?: string } = {}): PipelineEvent => ({
  type: 'message',
  chatId: extra.chatId ?? 'oc_chat',
  messageId: id,
  ...(sender ? { sender } : {}),
  receivedAtMs,
  timestampSec: Math.floor(receivedAtMs / 1000),
  utcOffsetMin: 0,
  content: [{ type: 'text', text: id }],
  attachments: [],
  ...(extra.selfSent ? { isSelfSent: true } : {}),
});

describe('memory migration', () => {
  it('applies to a database that already holds events and adds the cursor table and index', () => {
    const before = join(directory, 'drizzle-before');
    cpSync('drizzle', before, { recursive: true });
    const journalPath = join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter(entry => !entry.tag.startsWith('0035_'));
    writeFileSync(journalPath, JSON.stringify(journal));

    const db = open();
    migrate(db, { migrationsFolder: before });
    persistEvent(db, message('om_1', person('ou_a'), 1_000));
    expect(db.$client.prepare("select name from sqlite_master where name in ('memory_cursors', 'events_chat_received_idx')").all()).toEqual([]);

    runMigrations(db, logger);
    expect(db.$client.prepare("select name from sqlite_master where name in ('memory_cursors', 'events_chat_received_idx') order by name").all())
      .toEqual([{ name: 'events_chat_received_idx' }, { name: 'memory_cursors' }]);
    expect(db.$client.prepare('select count(*) as total from events').get()).toEqual({ total: 1 });
    expect(drizzle(db.$client, { schema }).select().from(schema.memoryCursors).all()).toEqual([]);
  });
});

describe('memory cursor', () => {
  it('starts at zero, moves with a run, keeps its place on an error-only run, and survives a restart', () => {
    let db = open();
    runMigrations(db, logger);
    expect(loadMemoryCursor(db, 'oc_chat')).toBe(0);
    persistMemoryRun(db, 'oc_chat', { cursorMs: 5_000, error: null, atMs: 6_000 });
    expect(loadMemoryCursor(db, 'oc_chat')).toBe(5_000);
    persistMemoryRun(db, 'oc_chat', { error: 'HTTP 503', atMs: 7_000 });
    expect(loadMemoryCursor(db, 'oc_chat')).toBe(5_000);
    expect(db.$client.prepare('select last_error, last_run_ms from memory_cursors').get()).toEqual({ last_error: 'HTTP 503', last_run_ms: 7_000 });
    expect(loadMemoryCursor(db, 'oc_other')).toBe(0);

    db.$client.close();
    opened.length = 0;
    db = open();
    expect(loadMemoryCursor(db, 'oc_chat')).toBe(5_000);

    // an error recorded before any cursor exists does not invent one
    persistMemoryRun(db, 'oc_new', { error: 'boom', atMs: 8_000 });
    expect(loadMemoryCursor(db, 'oc_new')).toBe(0);
  });
});

describe('human message queries', () => {
  const seed = (db: DB) => {
    // No `users` rows at all: Feishu never populates that table.
    persistEvent(db, message('om_1', person('ou_a'), 1_000));
    persistEvent(db, message('om_2', person('ou_b'), 2_000));
    persistEvent(db, message('om_3', person(BOT, true), 3_000, { selfSent: true }));
    persistEvent(db, message('om_4', person(BOT, true), 4_000));
    persistEvent(db, message('om_5', person('ou_otherbot', true), 5_000));
    persistEvent(db, message('om_6', person('ou_blocked'), 6_000));
    persistEvent(db, message('om_7', undefined, 7_000));
    persistEvent(db, message('om_8', person('ou_a'), 8_000));
    persistEvent(db, message('om_9', person('ou_a'), 9_000, { chatId: 'oc_other' }));
    persistEvent(db, { type: 'delete', chatId: 'oc_chat', messageIds: ['om_1'], receivedAtMs: 10_000, timestampSec: 10, utcOffsetMin: 0 });
    persistEvent(db, message('om_11', person('ou_a'), 11_000));
  };

  it('counts only humans: not the bot, not self-sent, not other bots, not blocked, not another chat', () => {
    const db = open();
    runMigrations(db, logger);
    seed(db);
    expect(countHumanMessagesSince(db, 'oc_chat', 0, BOT, ['ou_blocked'])).toBe(4);
    expect(countHumanMessagesSince(db, 'oc_chat', 0, BOT, [])).toBe(5);
    // exclusive: the message at the cursor itself is not counted again
    expect(countHumanMessagesSince(db, 'oc_chat', 2_000, BOT, ['ou_blocked'])).toBe(2);
    expect(countHumanMessagesSince(db, 'oc_chat', 11_000, BOT, ['ou_blocked'])).toBe(0);
    expect(countHumanMessagesSince(db, 'oc_nowhere', 0, BOT, [])).toBe(0);
  });

  it('is served by the (chat_id, received_at) index instead of scanning the chat', () => {
    const db = open();
    runMigrations(db, logger);
    seed(db);
    const { sql, params } = countHumanMessagesQuery(db, 'oc_chat', 5_000, BOT, ['ou_blocked']);
    const plan = db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    const detail = plan.map(row => row.detail).join('\n');
    expect(detail).toContain('events_chat_received_idx');
    expect(detail).toMatch(/chat_id=\? AND received_at>\?/);
    expect(detail).not.toMatch(/SCAN events/);
  });

  it('finds where a window of the newest N human messages starts, and whether older ones were left out', () => {
    const db = open();
    runMigrations(db, logger);
    seed(db);
    // human messages at 1000, 2000, 8000, 11000 (blocked excluded)
    expect(findHumanWindowStart(db, 'oc_chat', 0, BOT, ['ou_blocked'], 2)).toEqual({ startMs: 8_000, truncated: true });
    expect(findHumanWindowStart(db, 'oc_chat', 0, BOT, ['ou_blocked'], 4)).toEqual({ startMs: 1_000, truncated: false });
    expect(findHumanWindowStart(db, 'oc_chat', 0, BOT, ['ou_blocked'], 5)).toBeUndefined();
    // inclusive of the cursor itself
    expect(findHumanWindowStart(db, 'oc_chat', 2_000, BOT, ['ou_blocked'], 3)).toEqual({ startMs: 2_000, truncated: false });
  });

  it('lists the ids that delete events removed, per chat', () => {
    const db = open();
    runMigrations(db, logger);
    seed(db);
    persistEvent(db, { type: 'delete', chatId: 'oc_other', messageIds: ['om_9'], receivedAtMs: 12_000, timestampSec: 12, utcOffsetMin: 0 });
    expect([...loadDeletedMessageIds(db, 'oc_chat')]).toEqual(['om_1']);
    expect([...loadDeletedMessageIds(db, 'oc_other')]).toEqual(['om_9']);
  });
});
