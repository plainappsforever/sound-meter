import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Db } from '@/db/types';

/** In-memory SQLite with the expo-sqlite async API shape, for fast Node integration tests. */
export function createTestDb(): Db {
  const db = new DatabaseSync(':memory:');
  const fake = {
    async execAsync(sql: string) {
      db.exec(sql);
    },
    async runAsync(sql: string, ...params: SQLInputValue[]) {
      const result = db.prepare(sql).run(...params);
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async getAllAsync(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).all(...params);
    },
    async getFirstAsync(sql: string, ...params: SQLInputValue[]) {
      return db.prepare(sql).get(...params) ?? null;
    },
  };
  return fake as unknown as Db;
}
