/**
 * @jest-environment node
 */
import { FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL, type SecondRecord } from './dsp/meter';
import { BLOCK_BYTES, MISSING, createBlockAccumulator, decodeBlock, decodeValue, encodeBlock, encodeValue } from './codec';
import { recordsFromScript, seededRandom } from './signals';

const T0 = 1_790_000_000_000;

describe('codec (SPEC §7.9)', () => {
  it('rounds half away from zero, clamps, and maps non-finite to missing', () => {
    expect(encodeValue(67.45)).toBe(675);
    expect(encodeValue(-0.05)).toBe(-1);
    expect(encodeValue(0.04)).toBe(0);
    expect(encodeValue(5000)).toBe(32767);
    expect(encodeValue(-5000)).toBe(-32767);
    expect(encodeValue(NaN)).toBe(MISSING);
    expect(decodeValue(MISSING)).toBeNaN();
  });

  it('round-trip is exact to 0.1 dB, keeps flags and missing seconds', () => {
    const rnd = seededRandom(5);
    const slots: (SecondRecord | undefined)[] = [];
    for (let s = 0; s < 60; s++) {
      if (s % 7 === 3) continue; // missing second
      const v = () => Math.round((20 + rnd() * 100) * 10) / 10;
      slots[s] = {
        tMs: T0 + s * 1000,
        laeq: v(), lceq: v(), lzeq: v(), lafmax: v(), lafmin: v(), las: v(), lcpeak: v(),
        flags: s % 5 === 0 ? FLAG_OVERLOAD | FLAG_PARTIAL : 0,
      };
    }
    slots[10] = { tMs: T0 + 10_000, laeq: NaN, lceq: NaN, lzeq: NaN, lafmax: NaN, lafmin: NaN, las: NaN, lcpeak: NaN, flags: FLAG_MIC_BUSY };
    const data = encodeBlock(slots);
    expect(data.length).toBe(BLOCK_BYTES);
    const back = decodeBlock(T0, data);
    const expected = slots.filter((r): r is SecondRecord => r !== undefined);
    expect(back).toHaveLength(expected.length);
    back.forEach((r, i) => {
      const e = expected[i];
      expect(r.tMs).toBe(e.tMs);
      expect(r.flags).toBe(e.flags);
      for (const k of ['laeq', 'lceq', 'lzeq', 'lafmax', 'lafmin', 'las', 'lcpeak'] as const) {
        if (Number.isNaN(e[k])) expect(r[k]).toBeNaN();
        else expect(r[k]).toBe(e[k]);
      }
    });
  });

  it('rejects a block of the wrong size', () => {
    expect(() => decodeBlock(T0, new Uint8Array(899))).toThrow('900');
  });

  it('accumulator: completes a block when the next minute starts, pending() holds the rest, gaps leave holes', () => {
    const acc = createBlockAccumulator(T0);
    const recs = recordsFromScript(T0, [
      { seconds: 61, db: 40 },
      { seconds: 70, db: null },
      { seconds: 10, db: 50 },
    ]);
    const done = acc.add(recs);
    expect(done.map((b) => b.idx)).toEqual([0, 1]);
    expect(decodeBlock(done[1].startMs, done[1].data)).toHaveLength(1);
    const p = acc.pending();
    expect(p?.idx).toBe(2);
    expect(decodeBlock(p!.startMs, p!.data).map((r) => (r.tMs - T0) / 1000)).toEqual([131, 132, 133, 134, 135, 136, 137, 138, 139, 140]);
    expect(createBlockAccumulator(T0).pending()).toBeNull();
  });
});
