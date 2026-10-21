import { countHumanMessagesSince, findHumanWindowStart, loadDeletedMessageIds, loadEvents, loadMemoryCursor, loadMessageIds, persistMemoryRun } from '../../db';
import { createMarkdownMemoryStore } from '../../memory/store-md';
import { buildMemoryWindow } from '../../memory/window';
import { isMessageAlias, messageAlias } from '../../rendering';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerMemory = ({ get, register }: Registrar): void => {
  register(TOKENS.MEMORY_BACKEND, () =>
    createMarkdownMemoryStore({ rootDir: get(TOKENS.CONFIG).memoryDir, logger: get(TOKENS.LOGGER) }));

  // All DB access for memory lives here as closures over src/db; the memory
  // module itself never sees a connection or the container.
  register(TOKENS.MEMORY_DEPS, () => {
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const botUserId = get(TOKENS.PLATFORM_IDENTITY).botUserId();
    return {
      backend: get(TOKENS.MEMORY_BACKEND),
      loadCursor: chatId => loadMemoryCursor(db, chatId),
      advanceCursor: (chatId, cursorMs, lastError) => persistMemoryRun(db, chatId, { cursorMs, error: lastError, atMs: Date.now() }),
      recordError: (chatId, error) => persistMemoryRun(db, chatId, { error, atMs: Date.now() }),
      countHumanMessagesSince: (chatId, afterMs, blockedUserIds) =>
        countHumanMessagesSince(db, chatId, afterMs, botUserId, blockedUserIds),
      // The window starts at the memory cursor, never at the compaction cursor.
      // When more than `maxWindowMessages` human messages are waiting, only the
      // newest ones are read from the archive.
      buildWindow: (chatId, fromMs, blockedUserIds, maxWindowMessages) => {
        const start = findHumanWindowStart(db, chatId, fromMs, botUserId, [...blockedUserIds], maxWindowMessages);
        return buildMemoryWindow({
          chatId,
          events: loadEvents(db, chatId, Math.max(fromMs, start?.startMs ?? fromMs)),
          fromMs,
          renderParams: pipeline.getRenderParams(chatId),
          blockedUserIds,
          truncated: start?.truncated ?? false,
        });
      },
      // Positive deletion status only: an alias that matches no persisted
      // message (typo, hand-written) stays 'unknown' and never drops an entry.
      resolveEvidence: (chatId, aliases) => {
        const statuses = new Map<string, 'deleted' | 'alive' | 'unknown'>();
        if (aliases.length === 0) return statuses;
        const deleted = loadDeletedMessageIds(db, chatId);
        const known = loadMessageIds(db, chatId);
        const knownSet = new Set(known);
        const aliasing = pipeline.getRenderParams(chatId).aliasMessageIds === true;
        const byAlias = aliasing ? new Map(known.map(id => [messageAlias(chatId, id), id] as const)) : undefined;
        for (const alias of aliases) {
          const canonical = (byAlias && isMessageAlias(alias) ? byAlias.get(alias) : undefined) ?? (knownSet.has(alias) ? alias : undefined);
          statuses.set(alias, canonical === undefined ? 'unknown' : (deleted.has(canonical) ? 'deleted' : 'alive'));
        }
        return statuses;
      },
    };
  });
};
