import type { Gap, GapReason } from '@/engine/levels';

import { withRead, withWrite } from './tx';
import type { Db } from './types';

/** `open` = the gap has begun and not ended yet (review S4); its end_ms equals start_ms until it is closed. */
export type GapRow = Gap & { id: number; sessionId: number; open: boolean };
type Row = { id: number; session_id: number; start_ms: number; end_ms: number; reason: GapReason; open: number };

export async function addGap(db: Db, sessionId: number, gap: Gap): Promise<number> {
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      'INSERT INTO gaps (session_id, start_ms, end_ms, reason) VALUES (?, ?, ?, ?)',
      sessionId,
      gap.startMs,
      gap.endMs,
      gap.reason
    );
    return res.lastInsertRowId;
  });
}

/** Stores a gap the moment it begins (capture.ts onGapOpen), so a kill during it keeps its reason (review S4). */
export async function openGap(db: Db, sessionId: number, gap: { startMs: number; reason: GapReason }): Promise<number> {
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      'INSERT INTO gaps (session_id, start_ms, end_ms, reason, open) VALUES (?, ?, ?, ?, 1)',
      sessionId,
      gap.startMs,
      gap.startMs,
      gap.reason
    );
    return res.lastInsertRowId;
  });
}

/**
 * Closes the open row of this gap (same session, reason and start) — or inserts the gap if it was never stored open.
 * A zero-length gap (closed at its own start) leaves no row.
 */
export async function closeGap(db: Db, sessionId: number, gap: Gap): Promise<void> {
  await withWrite(db, async (tx) => {
    if (gap.endMs <= gap.startMs) {
      await tx.runAsync('DELETE FROM gaps WHERE session_id = ? AND reason = ? AND start_ms = ? AND open = 1', sessionId, gap.reason, gap.startMs);
      return;
    }
    const res = await tx.runAsync(
      'UPDATE gaps SET end_ms = ?, open = 0 WHERE session_id = ? AND reason = ? AND start_ms = ? AND open = 1',
      gap.endMs,
      sessionId,
      gap.reason,
      gap.startMs
    );
    if (res.changes === 0)
      await tx.runAsync('INSERT INTO gaps (session_id, start_ms, end_ms, reason) VALUES (?, ?, ?, ?)', sessionId, gap.startMs, gap.endMs, gap.reason);
  });
}

/** Recovery: every still-open gap of the session ends at `endMs` (the last sign of life). */
export async function closeOpenGaps(db: Db, sessionId: number, endMs: number): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync('UPDATE gaps SET end_ms = MAX(start_ms, ?), open = 0 WHERE session_id = ? AND open = 1', endMs, sessionId)
  );
}

export async function listGaps(db: Db, sessionId: number): Promise<GapRow[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<Row>('SELECT id, session_id, start_ms, end_ms, reason, open FROM gaps WHERE session_id = ? ORDER BY start_ms, id', sessionId)
  );
  return rows.map((g) => ({ id: g.id, sessionId: g.session_id, startMs: g.start_ms, endMs: g.end_ms, reason: g.reason, open: g.open === 1 }));
}
