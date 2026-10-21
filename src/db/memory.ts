import { and, count, desc, eq, gt, isNotNull, ne, notInArray, sql } from 'drizzle-orm';

import type { DB } from './client';
import { events, memoryCursors } from './schema';

export const loadMemoryCursor = (db: DB, chatId: string): number =>
  db.select({ cursorMs: memoryCursors.cursorMs })
    .from(memoryCursors)
    .where(eq(memoryCursors.chatId, chatId))
    .get()?.cursorMs ?? 0;

/**
 * Record a memory run. `cursorMs` moves the cursor; omitting it records only the
 * error and leaves the cursor where it was (a failed run replays its window).
 */
export const persistMemoryRun = (db: DB, chatId: string, run: { cursorMs?: number; error: string | null; atMs: number }): void => {
  db.insert(memoryCursors)
    .values({ chatId, cursorMs: run.cursorMs ?? 0, lastRunMs: run.atMs, lastError: run.error, updatedAt: run.atMs })
    .onConflictDoUpdate({
      target: memoryCursors.chatId,
      set: {
        ...(run.cursorMs !== undefined ? { cursorMs: run.cursorMs } : {}),
        lastRunMs: run.atMs,
        lastError: run.error,
        updatedAt: run.atMs,
      },
    })
    .run();
};

/**
 * Human message events after `afterMs` (exclusive): not the bot's own, not
 * another bot, not blocked. `users` is a Telegram-only table that Feishu never
 * populates, so bot-ness comes from the event's own sender JSON.
 */
const humanMessages = (chatId: string, afterMs: number, botUserId: string, blockedUserIds: readonly string[]) =>
  and(
    eq(events.chatId, chatId),
    eq(events.type, 'message'),
    gt(events.receivedAtMs, afterMs),
    sql`coalesce(${events.isSelfSent}, 0) = 0`,
    isNotNull(events.senderId),
    ne(events.senderId, botUserId),
    sql`coalesce(json_extract(${events.sender}, '$.isBot'), 0) = 0`,
    blockedUserIds.length > 0 ? notInArray(events.senderId, [...blockedUserIds]) : undefined,
  );

/**
 * Volume trigger. The comparison is exclusive while a run's window is inclusive
 * of its cursor, so one boundary message is drafted again without being counted;
 * the duplicate rule makes that harmless and an inclusive count would never fall
 * below one.
 */
export const countHumanMessagesSince = (db: DB, chatId: string, afterMs: number, botUserId: string, blockedUserIds: readonly string[]): number =>
  db.select({ total: count() })
    .from(events)
    .where(humanMessages(chatId, afterMs, botUserId, blockedUserIds))
    .get()?.total ?? 0;

/** Same predicate as the count, for tests that assert the query plan. */
export const countHumanMessagesQuery = (db: DB, chatId: string, afterMs: number, botUserId: string, blockedUserIds: readonly string[]) =>
  db.select({ total: count() })
    .from(events)
    .where(humanMessages(chatId, afterMs, botUserId, blockedUserIds))
    .toSQL();

/**
 * Where a window holding the newest `limit` human messages from `afterMs`
 * (inclusive) starts, so a long gap or a first run reads only that tail of the
 * archive. `truncated` means older messages since the cursor exist and are
 * skipped. Undefined when at most `limit` exist: the window starts at the cursor.
 */
export const findHumanWindowStart = (db: DB, chatId: string, afterMs: number, botUserId: string, blockedUserIds: readonly string[], limit: number): { startMs: number; truncated: boolean } | undefined => {
  const rows = db.select({ receivedAtMs: events.receivedAtMs })
    .from(events)
    .where(humanMessages(chatId, afterMs - 1, botUserId, blockedUserIds))
    .orderBy(desc(events.receivedAtMs), desc(events.id))
    .limit(2)
    .offset(limit - 1)
    .all();
  if (rows.length === 0) return undefined;
  return { startMs: rows[0]!.receivedAtMs, truncated: rows.length > 1 };
};

/** Ids of every message that a delete event removed, for the evidence sweep. */
export const loadDeletedMessageIds = (db: DB, chatId: string): Set<string> => {
  const rows = db.all<{ id: string }>(sql`
    select json_each.value as id
    from ${events}, json_each(${events.messageIds})
    where ${events.chatId} = ${chatId} and ${events.type} = 'delete'`);
  return new Set(rows.map(row => row.id));
};
