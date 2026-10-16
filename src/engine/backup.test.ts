/**
 * @jest-environment node
 */
import { createTestDb } from '../../test/node-sqlite-db';
import { newSession } from '../../test/fixtures';
import { exportBackupData, restoreBackup } from '@/db/backup';
import { upsertBlock, readRecords } from '@/db/blocks';
import { createCase, listCases } from '@/db/cases';
import { addManualEntry, listCaseEvents } from '@/db/events';
import { addGap } from '@/db/gaps';
import { LATEST_VERSION, migrate } from '@/db/migrations';
import { createSession, finaliseSession, getSession, listSessions } from '@/db/sessions';
import { setThemePreference, getThemePreference } from '@/db/settings';

import { buildBackup, decodeBase64, encodeBase64, validateBackup } from './backup';
import { createBlockAccumulator } from './codec';
import { recordsFromScript } from './signals';

async function seeded() {
  const db = createTestDb();
  await migrate(db);
  const caseId = await createCase(db, { name: 'Flat above', address: 'Main St 1', notes: 'n' }, 1);
  const start = Date.UTC(2026, 9, 24, 20);
  const sid = await createSession(db, newSession({ caseId, startedAt: start }));
  const recs = recordsFromScript(start, [
    { seconds: 900, db: 30 },
    { seconds: 60, db: 50 },
    { seconds: 300, db: 30 },
  ]);
  const acc = createBlockAccumulator(start);
  for (const b of acc.add(recs)) await upsertBlock(db, sid, b);
  await upsertBlock(db, sid, acc.pending()!);
  await addGap(db, sid, { startMs: start + 100_000, endMs: start + 110_000, reason: 'paused' });
  await finaliseSession(db, sid, recs[recs.length - 1].tMs + 1000);
  await addManualEntry(db, { caseId, startMs: 5, endMs: 6, category: 'voices', categoryOther: '', note: '', witnesses: 'A', effect: 'none' });
  await setThemePreference(db, 'dark');
  return { db, sid, caseId };
}

describe('backup and restore (F9, SPEC §12)', () => {
  it('round-trip into an empty database gives identical rows and records', async () => {
    const { db, sid, caseId } = await seeded();
    const json = JSON.stringify(buildBackup(await exportBackupData(db), LATEST_VERSION, 123));
    const target = createTestDb();
    await migrate(target);
    const res = await restoreBackup(target, json);
    expect(res).toEqual({ ok: true, summary: { cases: 1, sessions: 1, events: 2, blocks: 21 } });
    expect(await listCases(target)).toEqual(await listCases(db));
    expect(await listSessions(target)).toEqual(await listSessions(db));
    expect(await readRecords(target, sid)).toEqual(await readRecords(db, sid));
    expect(await listCaseEvents(target, caseId)).toEqual(await listCaseEvents(db, caseId));
    expect(await getThemePreference(target)).toBe('dark');
    expect(await exportBackupData(target)).toEqual(await exportBackupData(db));
  });

  it('refuses corrupt, foreign, newer or inconsistent backups and leaves the data unchanged', async () => {
    const { db, sid } = await seeded();
    const before = await exportBackupData(db);
    const good = buildBackup(before, LATEST_VERSION, 1);
    const bad: [unknown, string][] = [
      ['{not json', 'not-json'],
      [{ ...good, app: 'meter-tracker' }, 'wrong-app'],
      [{ ...good, schemaVersion: LATEST_VERSION + 1 }, 'newer-version'],
      [{ ...good, backupVersion: 2 }, 'newer-version'],
      [{ ...good, data: { ...good.data, blocks: [{ ...good.data.blocks[0], data: encodeBase64(new Uint8Array(10)) }] } }, 'invalid'],
      [{ ...good, data: { ...good.data, sessions: [{ ...good.data.sessions[0], caseId: 999 }] } }, 'invalid'],
      [{ ...good, data: { ...good.data, events: [{ ...good.data.events[0], sessionId: null, caseId: null }] } }, 'invalid'],
      [{ ...good, data: { ...good.data, gaps: [{ ...good.data.gaps[0], reason: 'nap' }] } }, 'invalid'],
    ];
    for (const [input, error] of bad) {
      expect(await restoreBackup(db, typeof input === 'string' ? input : JSON.stringify(input))).toEqual({ ok: false, error });
    }
    expect(await exportBackupData(db)).toEqual(before);
    expect((await getSession(db, sid))?.status).toBe('finished');
  });

  it('extra keys in a file are ignored (never become SQL column names)', async () => {
    const { db } = await seeded();
    const data = await exportBackupData(db);
    (data.cases[0] as Record<string, unknown>)['name) VALUES (1); DROP TABLE cases; --'] = 'x';
    const target = createTestDb();
    await migrate(target);
    expect((await restoreBackup(target, JSON.stringify(buildBackup(data, LATEST_VERSION, 1)))).ok).toBe(true);
    expect(await listCases(target)).toHaveLength(1);
  });

  it('base64 round-trips every length and rejects garbage', () => {
    for (let n = 0; n < 10; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
    expect(encodeBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(() => decodeBase64('abc')).toThrow();
    expect(validateBackup(42, LATEST_VERSION)).toEqual({ ok: false, error: 'wrong-app' });
  });
});
