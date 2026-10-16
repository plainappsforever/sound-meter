/**
 * @jest-environment node
 */
import { createTestDb } from '../../test/node-sqlite-db';
import { newSession } from '../../test/fixtures';
import { createBlockAccumulator, encodeBlock } from '@/engine/codec';
import { recordsFromScript } from '@/engine/signals';

import { lastDataEndMs, listBlocks, readRecords, upsertBlock } from './blocks';
import { createCase, deleteCase, getCase, listCases, updateCase } from './cases';
import { addManualEntry, getEvent, listCaseEntries, listCaseEvents, listSessionEvents, updateEventLabels } from './events';
import { addGap, closeGap, listGaps, openGap } from './gaps';
import { LATEST_VERSION, MIGRATIONS, migrate } from './migrations';
import { createProfile, getActiveProfile, listProfiles, setActiveProfile, updateCalibration } from './profiles';
import {
  createSession,
  deleteSession,
  finaliseSession,
  getSession,
  heartbeat,
  listSessions,
  recoverStaleSessions,
  redetectSession,
  updateSessionMeta,
} from './sessions';
import { getAppSetting, getLastBackupAt, getThemePreference, setAppSetting, setLastBackupAt, setThemePreference } from './settings';

const MIGRATIONS_UP_TO_2 = MIGRATIONS.slice(0, 2);

async function freshDb() {
  const db = createTestDb();
  await migrate(db);
  return db;
}

async function storeSeries(db: Awaited<ReturnType<typeof freshDb>>, sessionId: number, startMs: number, recs: ReturnType<typeof recordsFromScript>) {
  const acc = createBlockAccumulator(startMs);
  for (const b of acc.add(recs)) await upsertBlock(db, sessionId, b);
  const p = acc.pending();
  if (p) await upsertBlock(db, sessionId, p);
}

const NIGHT = (start: number) =>
  recordsFromScript(start, [
    { seconds: 900, db: 30 },
    { seconds: 60, db: 50 },
    { seconds: 5, db: 30 },
    { seconds: 10, db: 50 },
    { seconds: 600, db: 30 },
    { seconds: 30, db: 55, lc: 70 },
    { seconds: 300, db: 30 },
  ]);

describe('migrations', () => {
  it('reaches the latest version (3), is safe to run again, and replaces the template items table', async () => {
    const db = await freshDb();
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(3);
    const tables = (await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['blocks', 'cases', 'events', 'gaps', 'profiles', 'sessions', 'settings']));
    expect(tables).not.toContain('items');
  });

  it('upgrades a version-1 database (template schema with demo rows, settings kept)', async () => {
    const db = createTestDb();
    await migrate(db, [
      `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
       CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`,
    ]);
    await db.runAsync("INSERT INTO items (title, created_at) VALUES ('demo', 1)");
    await db.runAsync("INSERT INTO settings (key, value) VALUES ('theme', 'dark')");
    await migrate(db);
    expect(await getThemePreference(db)).toBe('dark');
    expect(await listCases(db)).toEqual([]);
  });

  it('migration 3 (review S4): a version-2 database keeps its gaps, which read as closed; open accepts only 0/1', async () => {
    const db = createTestDb();
    await migrate(db, MIGRATIONS_UP_TO_2);
    const sid = await createSession(db, newSession());
    await db.runAsync("INSERT INTO gaps (session_id, start_ms, end_ms, reason) VALUES (?, 10, 20, 'paused')", sid);
    await migrate(db);
    expect(await listGaps(db, sid)).toMatchObject([{ startMs: 10, endMs: 20, reason: 'paused', open: false }]);
    await expect(db.runAsync("INSERT INTO gaps (session_id, start_ms, end_ms, reason, open) VALUES (?, 1, 1, 'paused', 2)", sid)).rejects.toThrow();
  });

  it('A12: exactly one BLOB column (blocks.data) and it only accepts 900 bytes', async () => {
    const db = await freshDb();
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const blobs: string[] = [];
    for (const t of tables) {
      const cols = await db.getAllAsync<{ name: string; type: string }>(`PRAGMA table_info(${t.name})`);
      for (const c of cols) if (/BLOB/i.test(c.type)) blobs.push(`${t.name}.${c.name}`);
    }
    expect(blobs).toEqual(['blocks.data']);
    const id = await createSession(db, newSession());
    await expect(db.runAsync('INSERT INTO blocks (session_id, idx, start_ms, data) VALUES (?, 0, 0, ?)', id, new Uint8Array(901))).rejects.toThrow();
    await expect(upsertBlock(db, id, { idx: 0, startMs: 0, data: new Uint8Array(899) })).rejects.toThrow('900');
  });
});

describe('cases', () => {
  it('create, update, list newest first, delete keeps sessions under "No case" and removes manual entries', async () => {
    const db = await freshDb();
    const a = await createCase(db, { name: 'Flat above', address: 'Main St 1', notes: '' }, 1000);
    const b = await createCase(db, { name: 'Street', address: '', notes: '' }, 2000);
    expect((await listCases(db)).map((c) => c.id)).toEqual([b, a]);
    await updateCase(db, a, { name: 'Flat above, Oct', address: 'Main St 1', notes: 'n' }, 3000);
    expect(await getCase(db, a)).toMatchObject({ name: 'Flat above, Oct', notes: 'n', updatedAt: 3000 });
    const s = await createSession(db, newSession({ caseId: a }));
    const m = await addManualEntry(db, { caseId: a, startMs: 1, endMs: 2, category: 'voices', categoryOther: '', note: '', witnesses: 'Anna', effect: 'woke' });
    await deleteCase(db, a);
    expect(await getCase(db, a)).toBeNull();
    expect((await getSession(db, s))?.caseId).toBeNull();
    expect(await getEvent(db, m)).toBeNull();
    expect((await listSessions(db, { caseId: null })).map((x) => x.id)).toEqual([s]);
  });
});

describe('profiles', () => {
  it('stores calibration results and the active profile per route', async () => {
    const db = await freshDb();
    const id = await createProfile(db, {
      name: 'Built-in',
      deviceModel: 'Pixel 8 Pro',
      os: 'Android 16',
      route: 'builtin',
      audioSource: 'unprocessed',
      offsetDb: 129.99,
      method: 'platform-default',
      referenceMeter: '',
      calibratedAt: null,
      note: '',
    });
    expect(await getActiveProfile(db, 'builtin')).toBeNull();
    await setActiveProfile(db, 'builtin', id);
    await updateCalibration(db, id, { offsetDb: 134.29, method: 'reference-meter', referenceMeter: 'UT353', calibratedAt: 5000 });
    expect(await getActiveProfile(db, 'builtin')).toMatchObject({ offsetDb: 134.29, method: 'reference-meter', referenceMeter: 'UT353', calibratedAt: 5000 });
    expect(await getActiveProfile(db, 'wired')).toBeNull();
    expect(await listProfiles(db)).toHaveLength(1);
  });
});

describe('sessions, blocks, gaps, events', () => {
  it('stores the 1-s series in 900-byte minute blocks and reads it back exactly (0.1 dB)', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const id = await createSession(db, newSession({ startedAt: start }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    const blocks = await listBlocks(db, id);
    expect(blocks).toHaveLength(Math.ceil(recs.length / 60));
    expect(blocks.every((b) => b.data.length === 900)).toBe(true);
    expect(await readRecords(db, id)).toEqual(recs);
    expect(await lastDataEndMs(db, id)).toBe(recs[recs.length - 1].tMs + 1000);
    // upsert replaces the block in progress
    await upsertBlock(db, id, { idx: 0, startMs: start, data: encodeBlock([]) });
    expect((await readRecords(db, id)).length).toBe(recs.length - 60);
  });

  it('finalise: events (E6 + an LF event), summary, background; meta edit; delete removes everything', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const caseId = await createCase(db, { name: 'Flat above', address: '', notes: '' });
    const id = await createSession(db, newSession({ startedAt: start, caseId }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    // review S2: the gap total is the union of the gaps inside the session — overlapping rows count once, a row after
    // the end counts nothing
    await addGap(db, id, { startMs: start + 1_800_000, endMs: start + 1_810_000, reason: 'interruption' });
    await addGap(db, id, { startMs: start + 1_805_000, endMs: start + 1_810_000, reason: 'paused' });
    await addGap(db, id, { startMs: start + 2_000_000, endMs: start + 2_010_000, reason: 'interruption' });
    const end = recs[recs.length - 1].tMs + 1000;
    await finaliseSession(db, id, end);
    const s = await getSession(db, id);
    expect(s).toMatchObject({ status: 'finished', endedAt: end, backgroundDb: 30 });
    expect(s?.summary?.lafmax).toBe(55);
    expect(s?.summary?.gapMs).toBe(10_000);
    const ev = await listSessionEvents(db, id);
    expect(ev.map((e) => [(e.startMs - start) / 1000, (e.endMs - e.startMs) / 1000, e.source])).toEqual([
      [900, 75, 'auto'],
      [1575, 30, 'auto'],
    ]);
    expect(ev[0].laeq).toBeCloseTo(49.7, 2);
    expect(ev[1].lfHint).toBe(true);
    expect((await listCaseEvents(db, caseId)).map((e) => e.id)).toEqual(ev.map((e) => e.id));
    // finalising twice does not duplicate auto events
    await finaliseSession(db, id, end);
    expect(await listSessionEvents(db, id)).toHaveLength(2);
    await updateSessionMeta(db, id, { title: 'Night 1', place: 'Bedroom', operator: 'T', note: '', caseId: null });
    expect((await getSession(db, id))?.title).toBe('Night 1');
    await deleteSession(db, id);
    expect(await getSession(db, id)).toBeNull();
    expect(await listBlocks(db, id)).toEqual([]);
    expect(await listGaps(db, id)).toEqual([]);
    expect(await listSessionEvents(db, id)).toEqual([]);
  });

  it('re-detect keeps labelled events (as marks) and replaces the others', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const id = await createSession(db, newSession({ startedAt: start }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    await finaliseSession(db, id, recs[recs.length - 1].tMs + 1000);
    const [first] = await listSessionEvents(db, id);
    await updateEventLabels(db, first.id, { category: 'music', categoryOther: '', note: '', witnesses: 'Anna', effect: 'woke', excluded: false });
    await redetectSession(db, id, 'low');
    const after = await listSessionEvents(db, id);
    expect(after.find((e) => e.id === first.id)).toMatchObject({ source: 'mark', category: 'music', witnesses: 'Anna' });
    // 'low' (15 dB) still finds the 55-dB event (+25); the 50-dB one is kept as the labelled mark, not duplicated
    expect(after.map((e) => (e.startMs - start) / 1000)).toEqual([900, 1575]);
    expect((await getSession(db, id))?.sensitivity).toBe('low');
  });

  it('quick sessions get a summary but no events', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 12, 0, 0);
    const id = await createSession(db, newSession({ kind: 'quick', startedAt: start }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    await finaliseSession(db, id, recs[recs.length - 1].tMs + 1000);
    expect(await listSessionEvents(db, id)).toEqual([]);
    expect((await getSession(db, id))?.summary?.validMs).toBe(recs.length * 1000);
  });

  it('recovery after a kill: stale heartbeat → interrupted at the last heartbeat, app-killed gap inside it, events detected', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const id = await createSession(db, newSession({ startedAt: start }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    const dataEnd = recs[recs.length - 1].tMs + 1000;
    await heartbeat(db, id, dataEnd + 40_000);
    const fresh = await createSession(db, newSession({ startedAt: dataEnd }));
    await heartbeat(db, fresh, dataEnd + 200_000);
    expect(await recoverStaleSessions(db, dataEnd + 40_000 + 3 * 60_000)).toEqual([id]);
    // review S2: the session ends at its last sign of life, so the lost stretch lies inside it and counts in the total
    expect(await getSession(db, id)).toMatchObject({ status: 'interrupted', endedAt: dataEnd + 40_000 });
    expect((await getSession(db, id))?.summary?.gapMs).toBe(40_000);
    expect(await listGaps(db, id)).toMatchObject([{ startMs: dataEnd, endMs: dataEnd + 40_000, reason: 'app-killed' }]);
    expect(await listSessionEvents(db, id)).toHaveLength(2);
    expect((await getSession(db, fresh))?.status).toBe('recording');
  });

  it('review S4: a gap open at the kill keeps its reason up to the last heartbeat; app-killed only covers the rest', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const id = await createSession(db, newSession({ startedAt: start }));
    const recs = NIGHT(start);
    await storeSeries(db, id, start, recs);
    const dataEnd = recs[recs.length - 1].tMs + 1000;
    // an interruption began 20 s before the last stored second and was still open when the app died
    await openGap(db, id, { startMs: dataEnd - 20_000, reason: 'interruption' });
    expect(await listGaps(db, id)).toMatchObject([{ open: true, startMs: dataEnd - 20_000, endMs: dataEnd - 20_000 }]);
    await heartbeat(db, id, dataEnd + 60_000);
    expect(await recoverStaleSessions(db, dataEnd + 60_000 + 3 * 60_000)).toEqual([id]);
    expect(await listGaps(db, id)).toMatchObject([{ startMs: dataEnd - 20_000, endMs: dataEnd + 60_000, reason: 'interruption', open: false }]);
    expect((await getSession(db, id))?.summary?.gapMs).toBe(80_000);
  });

  it('open/close gap rows: closing updates the open row, a zero-length close leaves none, an unknown close inserts', async () => {
    const db = await freshDb();
    const id = await createSession(db, newSession());
    await openGap(db, id, { startMs: 100, reason: 'paused' });
    await openGap(db, id, { startMs: 150, reason: 'route-change' });
    await closeGap(db, id, { startMs: 100, endMs: 400, reason: 'paused' });
    await closeGap(db, id, { startMs: 150, endMs: 150, reason: 'route-change' });
    await closeGap(db, id, { startMs: 500, endMs: 600, reason: 'interruption' });
    expect((await listGaps(db, id)).map((g) => [g.startMs, g.endMs, g.reason, g.open])).toEqual([
      [100, 400, 'paused', false],
      [500, 600, 'interruption', false],
    ]);
  });

  it('review S8: a session whose recorder is known dead is recovered at once; a live recorder is never recovered', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const a = await createSession(db, newSession({ startedAt: start }));
    const b = await createSession(db, newSession({ startedAt: start }));
    await heartbeat(db, a, start + 60_000);
    await heartbeat(db, b, start + 60_000);
    // 30 s after the last heartbeat (not stale): the crash-and-reopen case for a, a JS reload with a live service for b
    const closed = await recoverStaleSessions(db, start + 90_000, (sid) => (sid === a ? false : true));
    expect(closed).toEqual([a]);
    expect((await getSession(db, b))?.status).toBe('recording');
    expect(await recoverStaleSessions(db, start + 60_000 + 3 * 60_000 + 1, () => true)).toEqual([]);
    expect(await recoverStaleSessions(db, start + 60_000 + 3 * 60_000 + 1)).toEqual([b]); // unknown → heartbeat age
  });

  it('D29 (a): a 3-hour fan with a door slam under it → one long event plus a nested peak, stored and re-detected', async () => {
    const db = await freshDb();
    const start = Date.UTC(2026, 9, 24, 20, 0, 0);
    const id = await createSession(db, newSession({ startedAt: start }));
    const recs = recordsFromScript(start, [
      { seconds: 900, db: 30 },
      { seconds: 5400, db: 42 }, // fan +12 dB
      { seconds: 3, db: 42, lafmax: 62 }, // door slam +20 dB above the fan
      { seconds: 5400, db: 42 },
      { seconds: 900, db: 30 },
    ]);
    await storeSeries(db, id, start, recs);
    await finaliseSession(db, id, recs[recs.length - 1].tMs + 1000);
    const ev = await listSessionEvents(db, id);
    expect(ev.map((e) => [(e.startMs - start) / 1000, (e.endMs - start) / 1000])).toEqual([
      [900, 900 + 10_803],
      [6300, 6303],
    ]);
  });

  it('manual entries: noted, not measured, listed per case; labels update', async () => {
    const db = await freshDb();
    const caseId = await createCase(db, { name: 'Flat above', address: '', notes: '' });
    const id = await addManualEntry(db, {
      caseId,
      startMs: 10,
      endMs: 20,
      category: 'footsteps',
      categoryOther: '',
      note: 'stomping',
      witnesses: '',
      effect: 'kept-awake',
    });
    expect(await listCaseEntries(db, caseId)).toMatchObject([{ id, source: 'manual', laeq: null, sessionId: null, category: 'footsteps' }]);
    await expect(
      addManualEntry(db, { caseId, startMs: 20, endMs: 10, category: null, categoryOther: '', note: '', witnesses: '', effect: null })
    ).rejects.toThrow();
  });
});

describe('settings', () => {
  it('theme defaults to system, persists changes, ignores invalid stored values', async () => {
    const db = await freshDb();
    expect(await getThemePreference(db)).toBe('system');
    await setThemePreference(db, 'dark');
    expect(await getThemePreference(db)).toBe('dark');
    await db.runAsync("UPDATE settings SET value = 'purple' WHERE key = 'theme'");
    expect(await getThemePreference(db)).toBe('system');
  });

  it('app settings have defaults and validate stored values; last backup time', async () => {
    const db = await freshDb();
    expect(await getAppSetting(db, 'weighting')).toBe('A');
    expect(await getAppSetting(db, 'sensitivity')).toBe('normal');
    await setAppSetting(db, 'timeWeighting', 'S');
    expect(await getAppSetting(db, 'timeWeighting')).toBe('S');
    await db.runAsync("INSERT INTO settings (key, value) VALUES ('chartWindow', '7')");
    expect(await getAppSetting(db, 'chartWindow')).toBe('5');
    expect(await getLastBackupAt(db)).toBeNull();
    await setLastBackupAt(db, 12345);
    expect(await getLastBackupAt(db)).toBe(12345);
  });
});
