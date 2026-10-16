import { withTransaction } from './tx';
import type { Db } from './types';

// Append-only. Never edit a migration that has shipped; add a new one instead.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   );`,
  // 2 (v1 P2, V1_PLAN "Data"): the sound-meter schema. `items` was the template demo table and never shipped.
  // Levels only: the one BLOB column is blocks.data, exactly 900 bytes of int16 tenths of dB (SPEC §6, A12).
  // Foreign keys document the relations; deletes are explicit in the data functions (PRAGMA foreign_keys is not
  // enabled on the shared connection, D27).
  `DROP TABLE items;
   CREATE TABLE cases (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, device_model TEXT NOT NULL,
     os TEXT NOT NULL, route TEXT NOT NULL CHECK (route IN ('builtin','wired','bluetooth','usb')),
     audio_source TEXT NOT NULL, offset_db REAL NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('platform-default','reference-meter','manual-entry')),
     reference_meter TEXT NOT NULL DEFAULT '', calibrated_at INTEGER, note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,
     case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('quick','log')), title TEXT NOT NULL, place TEXT NOT NULL DEFAULT '',
     operator TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
     started_at INTEGER NOT NULL, ended_at INTEGER, tz_name TEXT NOT NULL, tz_offset_min INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('recording','finished','interrupted')),
     profile_name TEXT NOT NULL, offset_db REAL NOT NULL, calib_method TEXT NOT NULL, calibrated_at INTEGER,
     reference_meter TEXT NOT NULL DEFAULT '', device_model TEXT NOT NULL, os_version TEXT NOT NULL,
     audio_source TEXT NOT NULL, sample_rate INTEGER NOT NULL, app_version TEXT NOT NULL,
     sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('high','normal','low')),
     background_db REAL, summary_json TEXT, last_heartbeat INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE blocks (session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL, start_ms INTEGER NOT NULL, data BLOB NOT NULL CHECK (length(data) = 900),
     PRIMARY KEY (session_id, idx));
   CREATE TABLE gaps (id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, start_ms INTEGER NOT NULL,
     end_ms INTEGER NOT NULL, reason TEXT NOT NULL
     CHECK (reason IN ('paused','interruption','mic-busy','app-killed','route-change','frames-lost')));
   CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
     case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
     source TEXT NOT NULL CHECK (source IN ('auto','mark','manual')), start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
     laeq REAL, lafmax REAL, lcpeak REAL, lceq REAL, lf_hint INTEGER, overload_s INTEGER NOT NULL DEFAULT 0,
     category TEXT, category_other TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
     witnesses TEXT NOT NULL DEFAULT '', effect TEXT CHECK (effect IN ('woke','kept-awake','disturbed','none')),
     excluded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     CHECK (session_id IS NOT NULL OR case_id IS NOT NULL));
   CREATE INDEX events_session ON events(session_id, start_ms);
   CREATE INDEX sessions_case ON sessions(case_id, started_at);`,
  // 3 (fix round 1, review S4): a gap row is written when the gap OPENS (open = 1, end_ms = start_ms) and closed later,
  // so a kill during an interruption keeps its true reason; recovery closes open rows at the last sign of life.
  `ALTER TABLE gaps ADD COLUMN open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1));`,
];

export const LATEST_VERSION = MIGRATIONS.length;

export async function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): Promise<void> {
  // The version is read INSIDE each unit: another JS handle on the same connection (e.g. a background task at a cold
  // start) may have migrated meanwhile, and a migration must never run twice. One transaction per migration: a
  // failure rolls back both the schema change and user_version.
  for (;;) {
    const applied = await withTransaction(db, async (tx) => {
      const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const version = row?.user_version ?? 0;
      if (version >= migrations.length) return false;
      await tx.execAsync(`${migrations[version]} PRAGMA user_version = ${version + 1};`);
      return true;
    });
    if (!applied) return;
  }
}
