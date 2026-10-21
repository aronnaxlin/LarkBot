import type { ConsolidatorDeps } from './consolidator';
import type { MemoryBackend } from './types';

// Everything the driver needs to run person memory for its chats: the file
// backend plus closures over the DB, built by the container registrar so no
// business factory ever sees the container.
export interface MemoryDeps extends ConsolidatorDeps {
  backend: MemoryBackend;
  loadCursor: (chatId: string) => number;
  // Moves the cursor and records `lastError` (null = clean run).
  advanceCursor: (chatId: string, cursorMs: number, lastError: string | null) => void;
  // Records a failed run without moving the cursor.
  recordError: (chatId: string, error: string) => void;
  countHumanMessagesSince: (chatId: string, afterMs: number, blockedUserIds: readonly string[]) => number;
}
