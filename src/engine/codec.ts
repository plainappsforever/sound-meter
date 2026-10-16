// Minute blocks of the 1-s series (SPEC §6, §7.9, D20): 60 records × (7 × int16 tenths of dB + 1 flag byte) = 900 bytes.
// int16 = round(value × 10), half away from zero, clamped to ±3276.7 dB; a missing value = −32768. Little endian.
// Record layout (15 bytes): laeq, lceq, lzeq, lafmax, lafmin, las, lcpeak (int16 each), flags (uint8).
// No audio can be stored in this format: it holds levels only (A12).
import type { SecondRecord } from './dsp/meter';

export const SECONDS_PER_BLOCK = 60;
export const RECORD_BYTES = 15;
export const BLOCK_BYTES = SECONDS_PER_BLOCK * RECORD_BYTES; // 900
export const MISSING = -32768;

const FIELDS = ['laeq', 'lceq', 'lzeq', 'lafmax', 'lafmin', 'las', 'lcpeak'] as const;

export function encodeValue(v: number): number {
  if (!Number.isFinite(v)) return MISSING;
  const r = Math.sign(v) * Math.round(Math.abs(v) * 10);
  return Math.max(-32767, Math.min(32767, r));
}

export function decodeValue(i: number): number {
  return i === MISSING ? NaN : i / 10;
}

/** Position of a record in a session: block index and slot (second) inside the block. */
export function blockPosition(sessionStartMs: number, tMs: number): { idx: number; slot: number } {
  const s = Math.round((tMs - sessionStartMs) / 1000);
  if (s < 0) throw new Error('record before session start');
  return { idx: Math.floor(s / SECONDS_PER_BLOCK), slot: s % SECONDS_PER_BLOCK };
}

export function blockStartMs(sessionStartMs: number, idx: number): number {
  return sessionStartMs + idx * SECONDS_PER_BLOCK * 1000;
}

/** Encodes up to 60 records (slot-indexed; undefined = missing second) into one 900-byte block. */
export function encodeBlock(slots: readonly (SecondRecord | undefined)[]): Uint8Array {
  const out = new Uint8Array(BLOCK_BYTES);
  const view = new DataView(out.buffer);
  for (let s = 0; s < SECONDS_PER_BLOCK; s++) {
    const r = slots[s];
    const base = s * RECORD_BYTES;
    FIELDS.forEach((f, k) => view.setInt16(base + 2 * k, r ? encodeValue(r[f]) : MISSING, true));
    view.setUint8(base + 14, r ? r.flags & 0xff : 0);
  }
  return out;
}

/** Decodes a block; a slot with all values missing and no flags is a missing second (no record). */
export function decodeBlock(startMs: number, data: Uint8Array): SecondRecord[] {
  if (data.length !== BLOCK_BYTES) throw new Error(`block must be ${BLOCK_BYTES} bytes, got ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: SecondRecord[] = [];
  for (let s = 0; s < SECONDS_PER_BLOCK; s++) {
    const base = s * RECORD_BYTES;
    const raw = FIELDS.map((_, k) => view.getInt16(base + 2 * k, true));
    const flags = view.getUint8(base + 14);
    if (flags === 0 && raw.every((v) => v === MISSING)) continue;
    const [laeq, lceq, lzeq, lafmax, lafmin, las, lcpeak] = raw.map(decodeValue);
    out.push({ tMs: startMs + s * 1000, laeq, lceq, lzeq, lafmax, lafmin, las, lcpeak, flags });
  }
  return out;
}

export type EncodedBlock = { idx: number; startMs: number; data: Uint8Array };

/**
 * Collects per-second records into minute blocks. `add` returns the blocks that are complete (a later second arrived);
 * `pending()` returns the block in progress (written periodically and at stop, so a crash loses ≤ 60 s, D20).
 */
export function createBlockAccumulator(sessionStartMs: number) {
  let idx = -1;
  let slots: (SecondRecord | undefined)[] = [];
  const build = (): EncodedBlock => ({ idx, startMs: blockStartMs(sessionStartMs, idx), data: encodeBlock(slots) });
  return {
    add(records: readonly SecondRecord[]): EncodedBlock[] {
      const done: EncodedBlock[] = [];
      for (const r of records) {
        const p = blockPosition(sessionStartMs, r.tMs);
        if (p.idx !== idx) {
          if (idx >= 0 && slots.some(Boolean)) done.push(build());
          idx = p.idx;
          slots = [];
        }
        slots[p.slot] = r;
      }
      return done;
    },
    pending(): EncodedBlock | null {
      return idx >= 0 && slots.some(Boolean) ? build() : null;
    },
  };
}
