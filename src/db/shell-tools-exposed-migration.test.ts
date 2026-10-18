import { readdirSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// The Drizzle tag is random, so locate the migration by its revision number.
const migrationFile = readdirSync(new URL('../../drizzle', import.meta.url))
  .find(name => name.startsWith('0034_'));
if (!migrationFile) throw new Error('Missing 0034 shell_tools_exposed migration');

const statements = readFileSync(new URL(`../../drizzle/${migrationFile}`, import.meta.url), 'utf8')
  .split('--> statement-breakpoint')
  .map(statement => statement.trim())
  .filter(statement => statement.length > 0);

const insertWithoutFlag = (db: Database.Database, id: number): void => {
  db.prepare(`
    INSERT INTO turn_responses_v2
      (id, requested_at, entries, input_tokens, output_tokens)
    VALUES (?, ?, '[]', 1, 1)
  `).run(id, id * 100);
};

const insertWithFlag = (db: Database.Database, id: number, flag: number | null): void => {
  db.prepare(`
    INSERT INTO turn_responses_v2
      (id, requested_at, entries, input_tokens, output_tokens, shell_tools_exposed)
    VALUES (?, ?, '[]', 1, 1, ?)
  `).run(id, id * 100, flag);
};

describe('shell_tools_exposed migration', () => {
  it('backfills existing rows to false, defaults new rows to false, and rejects NULL', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE turn_responses_v2 (
          id INTEGER PRIMARY KEY,
          requested_at INTEGER NOT NULL,
          entries TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          model_name TEXT NOT NULL DEFAULT ''
        );
      `);
      insertWithoutFlag(db, 1);

      for (const statement of statements) db.exec(statement);

      // Pre-migration rows fail closed (false).
      expect(db.prepare('SELECT shell_tools_exposed AS exposed FROM turn_responses_v2 WHERE id = 1').get())
        .toEqual({ exposed: 0 });

      // New inserts without the column also default to false.
      insertWithoutFlag(db, 2);
      expect(db.prepare('SELECT shell_tools_exposed AS exposed FROM turn_responses_v2 WHERE id = 2').get())
        .toEqual({ exposed: 0 });

      // The gate can persist an open decision, and NULL is rejected.
      insertWithFlag(db, 3, 1);
      expect(db.prepare('SELECT shell_tools_exposed AS exposed FROM turn_responses_v2 WHERE id = 3').get())
        .toEqual({ exposed: 1 });
      expect(() => insertWithFlag(db, 4, null)).toThrow();
    } finally {
      db.close();
    }
  });
});
