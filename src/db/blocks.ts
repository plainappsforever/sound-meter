// The 1-s series, one 900-byte row per minute (SPEC §6, D20). Writers call upsertBlock once per minute and at stop.
import { BLOCK_BYTES, decodeBlock, type EncodedBlock } from '@/engine/codec';
import type { SecondRecord } from '@/engine/dsp/meter';

import { withRead, withWrite } from './tx';
import type { Db } from './types';

type Row = { idx: number; start_ms: number; data: Uint8Array };

export async function upsertBlock(db: Db, sessionId: number, block: EncodedBlock): Promise<void> {
  if (block.data.length !== BLOCK_BYTES) throw new Error(`block must be ${BLOCK_BYTES} bytes`);
  await withWrite(db, (tx) =>
    tx.runAsync(
      `INSERT INTO blocks (session_id, idx, start_ms, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, idx) DO UPDATE SET start_ms = excluded.start_ms, data = excluded.data`,
      sessionId,
      block.idx,
      block.startMs,
      block.data
    )
  );
}

export async function listBlocks(db: Db, sessionId: number): Promise<EncodedBlock[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<Row>('SELECT idx, start_ms, data FROM blocks WHERE session_id = ? ORDER BY idx', sessionId)
  );
  return rows.map((b) => ({ idx: b.idx, startMs: b.start_ms, data: new Uint8Array(b.data) }));
}

/** The decoded 1-s records of a session, oldest first. */
export async function readRecords(db: Db, sessionId: number): Promise<SecondRecord[]> {
  const blocks = await listBlocks(db, sessionId);
  return blocks.flatMap((b) => decodeBlock(b.startMs, b.data));
}

/** End of the last stored second (tMs + 1000), or null. */
export async function lastDataEndMs(db: Db, sessionId: number): Promise<number | null> {
  const row = await withRead(db, (r) =>
    r.getFirstAsync<Row>('SELECT idx, start_ms, data FROM blocks WHERE session_id = ? ORDER BY idx DESC LIMIT 1', sessionId)
  );
  if (!row) return null;
  const recs = decodeBlock(row.start_ms, new Uint8Array(row.data));
  return recs.length ? recs[recs.length - 1].tMs + 1000 : row.start_ms;
}
