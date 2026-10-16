// Cases: a named dispute/topic that groups night logs and manual entries (SPEC §6, F5).
import { withRead, withTransaction, withWrite } from './tx';
import type { Db } from './types';

export type Case = { id: number; name: string; address: string; notes: string; createdAt: number; updatedAt: number };
export type CaseInput = { name: string; address: string; notes: string };

type Row = { id: number; name: string; address: string; notes: string; created_at: number; updated_at: number };
const COLS = 'id, name, address, notes, created_at, updated_at';
const map = (r: Row): Case => ({
  id: r.id,
  name: r.name,
  address: r.address,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listCases(db: Db): Promise<Case[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>(`SELECT ${COLS} FROM cases ORDER BY updated_at DESC, id DESC`));
  return rows.map(map);
}

export async function getCase(db: Db, id: number): Promise<Case | null> {
  const row = await withRead(db, (r) => r.getFirstAsync<Row>(`SELECT ${COLS} FROM cases WHERE id = ?`, id));
  return row ? map(row) : null;
}

export async function createCase(db: Db, input: CaseInput, now = Date.now()): Promise<number> {
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      'INSERT INTO cases (name, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      input.name,
      input.address,
      input.notes,
      now,
      now
    );
    return res.lastInsertRowId;
  });
}

export async function updateCase(db: Db, id: number, input: CaseInput, now = Date.now()): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      'UPDATE cases SET name = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?',
      input.name,
      input.address,
      input.notes,
      now,
      id
    )
  );
}

/** Deletes a case and its manual entries; its sessions stay and move to "No case". */
export async function deleteCase(db: Db, id: number, now = Date.now()): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.runAsync('DELETE FROM events WHERE case_id = ? AND session_id IS NULL', id);
    await tx.runAsync('UPDATE events SET case_id = NULL, updated_at = ? WHERE case_id = ?', now, id);
    await tx.runAsync('UPDATE sessions SET case_id = NULL, updated_at = ? WHERE case_id = ?', now, id);
    await tx.runAsync('DELETE FROM cases WHERE id = ?', id);
  });
}
