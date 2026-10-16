// Sessions (quick measurements and night logs) with their calibration/device snapshots (SPEC §6, F2–F4), plus the
// finalise (events + summary), re-detect and recovery steps that run over the stored 1-s series.
import type { AudioSource, CalibMethod } from '@/engine/calibration';
import { detectEvents, flattenCandidates, planRedetect, type Sensitivity } from '@/engine/events';
import { aggregate, backgroundL90, subtractIntervals, type Summary } from '@/engine/levels';
import { recoverSession } from '@/engine/session';

import { lastDataEndMs, readRecords } from './blocks';
import { insertMeasuredEvents, listSessionEvents } from './events';
import { addGap, closeOpenGaps, listGaps } from './gaps';
import { withRead, withTransaction, withWrite } from './tx';
import type { Db } from './types';

export type SessionKind = 'quick' | 'log';
export type SessionStatus = 'recording' | 'finished' | 'interrupted';

/** What the recorder knows at start: meta + the calibration and device snapshot (never changes afterwards). */
export type NewSession = {
  caseId: number | null;
  kind: SessionKind;
  title: string;
  place: string;
  operator: string;
  note: string;
  startedAt: number;
  tzName: string;
  tzOffsetMin: number;
  profileName: string;
  offsetDb: number;
  calibMethod: CalibMethod;
  calibratedAt: number | null;
  referenceMeter: string;
  deviceModel: string;
  osVersion: string;
  audioSource: AudioSource;
  sampleRate: number;
  appVersion: string;
  sensitivity: Sensitivity;
};

export type Session = NewSession & {
  id: number;
  endedAt: number | null;
  status: SessionStatus;
  backgroundDb: number | null;
  summary: Summary | null;
  lastHeartbeat: number | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: number;
  case_id: number | null;
  kind: SessionKind;
  title: string;
  place: string;
  operator: string;
  note: string;
  started_at: number;
  ended_at: number | null;
  tz_name: string;
  tz_offset_min: number;
  status: SessionStatus;
  profile_name: string;
  offset_db: number;
  calib_method: CalibMethod;
  calibrated_at: number | null;
  reference_meter: string;
  device_model: string;
  os_version: string;
  audio_source: AudioSource;
  sample_rate: number;
  app_version: string;
  sensitivity: Sensitivity;
  background_db: number | null;
  summary_json: string | null;
  last_heartbeat: number | null;
  created_at: number;
  updated_at: number;
};

const COLS = `id, case_id, kind, title, place, operator, note, started_at, ended_at, tz_name, tz_offset_min, status,
  profile_name, offset_db, calib_method, calibrated_at, reference_meter, device_model, os_version, audio_source,
  sample_rate, app_version, sensitivity, background_db, summary_json, last_heartbeat, created_at, updated_at`;

/** JSON has no NaN: store null, read back NaN. */
export function summaryToJson(s: Summary): string {
  return JSON.stringify(s, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));
}

export function summaryFromJson(json: string | null): Summary | null {
  if (!json) return null;
  const nanify = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === null && k !== 'firstMs' && k !== 'lastMs') o[k] = NaN;
      else if (v && typeof v === 'object') nanify(v as Record<string, unknown>);
    }
    return o;
  };
  return nanify(JSON.parse(json)) as unknown as Summary;
}

const map = (r: Row): Session => ({
  id: r.id,
  caseId: r.case_id,
  kind: r.kind,
  title: r.title,
  place: r.place,
  operator: r.operator,
  note: r.note,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  tzName: r.tz_name,
  tzOffsetMin: r.tz_offset_min,
  status: r.status,
  profileName: r.profile_name,
  offsetDb: r.offset_db,
  calibMethod: r.calib_method,
  calibratedAt: r.calibrated_at,
  referenceMeter: r.reference_meter,
  deviceModel: r.device_model,
  osVersion: r.os_version,
  audioSource: r.audio_source,
  sampleRate: r.sample_rate,
  appVersion: r.app_version,
  sensitivity: r.sensitivity,
  backgroundDb: r.background_db,
  summary: summaryFromJson(r.summary_json),
  lastHeartbeat: r.last_heartbeat,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function createSession(db: Db, s: NewSession, now = Date.now()): Promise<number> {
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      `INSERT INTO sessions (case_id, kind, title, place, operator, note, started_at, tz_name, tz_offset_min, status,
         profile_name, offset_db, calib_method, calibrated_at, reference_meter, device_model, os_version, audio_source,
         sample_rate, app_version, sensitivity, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.caseId,
      s.kind,
      s.title,
      s.place,
      s.operator,
      s.note,
      s.startedAt,
      s.tzName,
      s.tzOffsetMin,
      s.profileName,
      s.offsetDb,
      s.calibMethod,
      s.calibratedAt,
      s.referenceMeter,
      s.deviceModel,
      s.osVersion,
      s.audioSource,
      s.sampleRate,
      s.appVersion,
      s.sensitivity,
      s.startedAt,
      now,
      now
    );
    return res.lastInsertRowId;
  });
}

export async function getSession(db: Db, id: number): Promise<Session | null> {
  const row = await withRead(db, (r) => r.getFirstAsync<Row>(`SELECT ${COLS} FROM sessions WHERE id = ?`, id));
  return row ? map(row) : null;
}

/** Sessions newest first; `caseId: null` = sessions without a case ("No case"), undefined = all. */
export async function listSessions(db: Db, filter: { caseId?: number | null } = {}): Promise<Session[]> {
  const rows = await withRead(db, (r) =>
    filter.caseId === undefined
      ? r.getAllAsync<Row>(`SELECT ${COLS} FROM sessions ORDER BY started_at DESC, id DESC`)
      : filter.caseId === null
        ? r.getAllAsync<Row>(`SELECT ${COLS} FROM sessions WHERE case_id IS NULL ORDER BY started_at DESC, id DESC`)
        : r.getAllAsync<Row>(`SELECT ${COLS} FROM sessions WHERE case_id = ? ORDER BY started_at DESC, id DESC`, filter.caseId)
  );
  return rows.map(map);
}

export type SessionMeta = { title: string; place: string; operator: string; note: string; caseId: number | null };

export async function updateSessionMeta(db: Db, id: number, m: SessionMeta, now = Date.now()): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      'UPDATE sessions SET title = ?, place = ?, operator = ?, note = ?, case_id = ?, updated_at = ? WHERE id = ?',
      m.title,
      m.place,
      m.operator,
      m.note,
      m.caseId,
      now,
      id
    )
  );
}

export async function heartbeat(db: Db, id: number, t: number): Promise<void> {
  await withWrite(db, (tx) => tx.runAsync("UPDATE sessions SET last_heartbeat = ? WHERE id = ? AND status = 'recording'", t, id));
}

/** Deletes a session with its blocks, gaps and events (explicit, D27). */
export async function deleteSession(db: Db, id: number): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.runAsync('DELETE FROM events WHERE session_id = ?', id);
    await tx.runAsync('DELETE FROM gaps WHERE session_id = ?', id);
    await tx.runAsync('DELETE FROM blocks WHERE session_id = ?', id);
    await tx.runAsync('DELETE FROM sessions WHERE id = ?', id);
  });
}

/**
 * Finalise (SPEC §7.7 step 5): run detection once over the stored series (logs only; quick sessions get no events),
 * store the events (`auto`), the summary and the background L90 outside events, close the session.
 */
export async function finaliseSession(
  db: Db,
  id: number,
  endedAt: number,
  status: 'finished' | 'interrupted' = 'finished',
  now = Date.now()
): Promise<void> {
  const session = await getSession(db, id);
  if (!session) throw new Error(`session ${id} not found`);
  const records = await readRecords(db, id);
  const gaps = await listGaps(db, id);
  const candidates =
    session.kind === 'log'
      ? flattenCandidates(
          detectEvents(records, gaps, { sensitivity: session.sensitivity, sessionStartMs: session.startedAt, sessionEndMs: endedAt })
        )
      : [];
  const summary = aggregate(records, gaps, { startMs: session.startedAt, endMs: endedAt });
  const background = backgroundL90(records, candidates, gaps);
  await withTransaction(db, async (tx) => {
    await tx.runAsync("DELETE FROM events WHERE session_id = ? AND source = 'auto'", id);
    await insertMeasuredEvents(tx, id, 'auto', candidates, now);
    await tx.runAsync(
      'UPDATE sessions SET ended_at = ?, status = ?, summary_json = ?, background_db = ?, updated_at = ? WHERE id = ?',
      endedAt,
      status,
      summaryToJson(summary),
      Number.isFinite(background) ? background : null,
      now,
      id
    );
  });
}

/** Re-detect with another sensitivity, keeping the user's labels (SPEC §7.7 step 5, engine planRedetect). */
export async function redetectSession(db: Db, id: number, sensitivity: Sensitivity, now = Date.now()): Promise<void> {
  const session = await getSession(db, id);
  if (!session) throw new Error(`session ${id} not found`);
  const records = await readRecords(db, id);
  const gaps = await listGaps(db, id);
  const existing = await listSessionEvents(db, id);
  const candidates = flattenCandidates(
    detectEvents(records, gaps, {
      sensitivity,
      sessionStartMs: session.startedAt,
      sessionEndMs: session.endedAt ?? undefined,
    })
  );
  const plan = planRedetect(existing, candidates);
  const keptIntervals = existing.filter((e) => !plan.removeIds.includes(e.id));
  const background = backgroundL90(records, [...keptIntervals, ...plan.insert], gaps);
  await withTransaction(db, async (tx) => {
    for (const rid of plan.removeIds) await tx.runAsync('DELETE FROM events WHERE id = ?', rid);
    for (const cid of plan.convertToMarkIds)
      await tx.runAsync("UPDATE events SET source = 'mark', updated_at = ? WHERE id = ?", now, cid);
    await insertMeasuredEvents(tx, id, 'auto', plan.insert, now);
    await tx.runAsync(
      'UPDATE sessions SET sensitivity = ?, background_db = ?, updated_at = ? WHERE id = ?',
      sensitivity,
      Number.isFinite(background) ? background : null,
      now,
      id
    );
  });
}

/**
 * App start: close every `recording` session that has no live recorder (engine recoverSession; review S8 — the
 * recorder service answers `recorderAlive`, else the heartbeat age decides). Open gaps end at the last sign of life
 * (S4); the `app-killed` gap covers only time no stored gap explains. Returns closed ids.
 */
export async function recoverStaleSessions(
  db: Db,
  now = Date.now(),
  recorderAlive?: (sessionId: number) => boolean | null
): Promise<number[]> {
  const recording = await withRead(db, (r) =>
    r.getAllAsync<Row>(`SELECT ${COLS} FROM sessions WHERE status = 'recording' ORDER BY id`)
  );
  const closed: number[] = [];
  for (const row of recording) {
    const s = map(row);
    const r = recoverSession(
      {
        status: s.status,
        startedAt: s.startedAt,
        lastHeartbeat: s.lastHeartbeat,
        lastDataEndMs: await lastDataEndMs(db, s.id),
        recorderAlive: recorderAlive?.(s.id) ?? null,
      },
      now
    );
    if (!r) continue;
    await closeOpenGaps(db, s.id, r.endedAt);
    if (r.gap) {
      const known = await listGaps(db, s.id);
      for (const piece of subtractIntervals(r.gap, known)) await addGap(db, s.id, { ...piece, reason: 'app-killed' });
    }
    await finaliseSession(db, s.id, r.endedAt, 'interrupted', now);
    closed.push(s.id);
  }
  return closed;
}
