// Backup export/restore against the database (SPEC F9, §7.9). The engine (src/engine/backup.ts) builds and validates
// the container; this file reads every table and replaces everything in ONE transaction (all or nothing).
import { BACKUP_COLUMNS, decodeBase64, encodeBase64, validateBackup, type Backup, type BackupData } from '@/engine/backup';

import { LATEST_VERSION } from './migrations';
import { withRead, withTransaction } from './tx';
import type { Db } from './types';

const TABLES = ['cases', 'profiles', 'sessions', 'gaps', 'events', 'settings'] as const;
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));
}

export async function exportBackupData(db: Db): Promise<BackupData> {
  return withRead(db, async (r) => {
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      const order = t === 'settings' ? 'key' : 'id';
      out[t] = (await r.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY ${order}`)).map(toCamel);
    }
    const blocks = await r.getAllAsync<{ session_id: number; idx: number; start_ms: number; data: Uint8Array }>(
      'SELECT session_id, idx, start_ms, data FROM blocks ORDER BY session_id, idx'
    );
    out.blocks = blocks.map((b) => ({ sessionId: b.session_id, idx: b.idx, startMs: b.start_ms, data: encodeBase64(new Uint8Array(b.data)) }));
    return out as unknown as BackupData;
  });
}

export type RestoreSummary = { cases: number; sessions: number; events: number; blocks: number };

/** Validates, then replaces all data in one transaction. A failure anywhere leaves the database unchanged. */
export async function restoreBackup(db: Db, input: unknown): Promise<{ ok: true; summary: RestoreSummary } | { ok: false; error: string }> {
  const v = validateBackup(input, LATEST_VERSION);
  if (!v.ok) return { ok: false, error: v.error };
  const backup: Backup = v.backup;
  await withTransaction(db, async (tx) => {
    for (const t of ['events', 'gaps', 'blocks', 'sessions', 'profiles', 'cases', 'settings']) await tx.runAsync(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      for (const row of backup.data[t] as unknown as Record<string, unknown>[]) {
        const cols = BACKUP_COLUMNS[t]; // fixed list: a file can never name a column
        await tx.runAsync(
          `INSERT INTO ${t} (${cols.map(snake).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          ...(cols.map((c) => row[c]) as (string | number | null)[])
        );
      }
    }
    for (const b of backup.data.blocks)
      await tx.runAsync('INSERT INTO blocks (session_id, idx, start_ms, data) VALUES (?, ?, ?, ?)', b.sessionId, b.idx, b.startMs, decodeBase64(b.data));
  });
  return {
    ok: true,
    summary: {
      cases: backup.data.cases.length,
      sessions: backup.data.sessions.length,
      events: backup.data.events.length,
      blocks: backup.data.blocks.length,
    },
  };
}
