// Events: auto-detected disturbances, "Mark now" marks and manual entries ("noted, not measured") (SPEC §6, §7.7, F4, F5).
import type { EventCandidate, EventLabels, EventMetrics } from '@/engine/events';

import { withRead, withTransaction, withWrite } from './tx';
import type { Db } from './types';

export type EventSource = 'auto' | 'mark' | 'manual';
export type Effect = 'woke' | 'kept-awake' | 'disturbed' | 'none';
export const CATEGORIES = ['footsteps', 'music', 'voices', 'door', 'diy', 'dog', 'appliance', 'traffic', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export type StoredEvent = EventLabels & {
  id: number;
  sessionId: number | null;
  caseId: number | null;
  source: EventSource;
  startMs: number;
  endMs: number;
  laeq: number | null;
  lafmax: number | null;
  lcpeak: number | null;
  lceq: number | null;
  lfHint: boolean | null;
  overloadS: number;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: number;
  session_id: number | null;
  case_id: number | null;
  source: EventSource;
  start_ms: number;
  end_ms: number;
  laeq: number | null;
  lafmax: number | null;
  lcpeak: number | null;
  lceq: number | null;
  lf_hint: number | null;
  overload_s: number;
  category: string | null;
  category_other: string;
  note: string;
  witnesses: string;
  effect: Effect | null;
  excluded: number;
  created_at: number;
  updated_at: number;
};

const COLS = `id, session_id, case_id, source, start_ms, end_ms, laeq, lafmax, lcpeak, lceq, lf_hint, overload_s,
  category, category_other, note, witnesses, effect, excluded, created_at, updated_at`;

const map = (r: Row): StoredEvent => ({
  id: r.id,
  sessionId: r.session_id,
  caseId: r.case_id,
  source: r.source,
  startMs: r.start_ms,
  endMs: r.end_ms,
  laeq: r.laeq,
  lafmax: r.lafmax,
  lcpeak: r.lcpeak,
  lceq: r.lceq,
  lfHint: r.lf_hint === null ? null : r.lf_hint === 1,
  overloadS: r.overload_s,
  category: r.category,
  categoryOther: r.category_other,
  note: r.note,
  witnesses: r.witnesses,
  effect: r.effect,
  excluded: r.excluded === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** NaN (no valid seconds) is stored as NULL. */
const num = (v: number) => (Number.isFinite(v) ? v : null);

/** Inserts measured events (auto or mark) for a session; used inside finalise/re-detect transactions too. */
export async function insertMeasuredEvents(
  db: Db,
  sessionId: number,
  source: 'auto' | 'mark',
  items: readonly (EventMetrics & { startMs: number; endMs: number })[],
  now = Date.now()
): Promise<number[]> {
  return withTransaction(db, async (tx) => {
    const ids: number[] = [];
    for (const e of items) {
      const res = await tx.runAsync(
        `INSERT INTO events (session_id, source, start_ms, end_ms, laeq, lafmax, lcpeak, lceq, lf_hint, overload_s,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        source,
        e.startMs,
        e.endMs,
        num(e.laeq),
        num(e.lafmax),
        num(e.lcpeak),
        num(e.lceq),
        Number.isFinite(e.lceq - e.laeq) ? (e.lfHint ? 1 : 0) : null,
        e.overloadS,
        now,
        now
      );
      ids.push(res.lastInsertRowId);
    }
    return ids;
  });
}

export type ManualEntryInput = {
  caseId: number;
  startMs: number;
  endMs: number;
  category: Category | null;
  categoryOther: string;
  note: string;
  witnesses: string;
  effect: Effect | null;
};

/** A manual entry: noted, not measured (no session, no levels). */
export async function addManualEntry(db: Db, e: ManualEntryInput, now = Date.now()): Promise<number> {
  if (e.endMs < e.startMs) throw new Error('entry ends before it starts');
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      `INSERT INTO events (case_id, source, start_ms, end_ms, category, category_other, note, witnesses, effect,
         created_at, updated_at) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.caseId,
      e.startMs,
      e.endMs,
      e.category,
      e.categoryOther,
      e.note,
      e.witnesses,
      e.effect,
      now,
      now
    );
    return res.lastInsertRowId;
  });
}

export async function updateEventLabels(db: Db, id: number, l: EventLabels, now = Date.now()): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      `UPDATE events SET category = ?, category_other = ?, note = ?, witnesses = ?, effect = ?, excluded = ?,
         updated_at = ? WHERE id = ?`,
      l.category,
      l.categoryOther,
      l.note,
      l.witnesses,
      l.effect,
      l.excluded ? 1 : 0,
      now,
      id
    )
  );
}

export async function getEvent(db: Db, id: number): Promise<StoredEvent | null> {
  const row = await withRead(db, (r) => r.getFirstAsync<Row>(`SELECT ${COLS} FROM events WHERE id = ?`, id));
  return row ? map(row) : null;
}

export async function listSessionEvents(db: Db, sessionId: number): Promise<StoredEvent[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<Row>(`SELECT ${COLS} FROM events WHERE session_id = ? ORDER BY start_ms, id`, sessionId)
  );
  return rows.map(map);
}

/** Manual entries of a case (no session). */
export async function listCaseEntries(db: Db, caseId: number): Promise<StoredEvent[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<Row>(`SELECT ${COLS} FROM events WHERE case_id = ? AND session_id IS NULL ORDER BY start_ms, id`, caseId)
  );
  return rows.map(map);
}

/** Every event of a case: those of its sessions plus its manual entries, by time. */
export async function listCaseEvents(db: Db, caseId: number): Promise<StoredEvent[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<Row>(
      `SELECT ${COLS} FROM events WHERE (case_id = ? AND session_id IS NULL)
         OR session_id IN (SELECT id FROM sessions WHERE case_id = ?) ORDER BY start_ms, id`,
      caseId,
      caseId
    )
  );
  return rows.map(map);
}

export async function deleteEvent(db: Db, id: number): Promise<void> {
  await withWrite(db, (tx) => tx.runAsync('DELETE FROM events WHERE id = ?', id));
}

export type { EventCandidate };
