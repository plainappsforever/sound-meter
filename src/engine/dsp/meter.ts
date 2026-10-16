// Per-buffer level processor (SPEC §7.1–7.5, V1_PLAN "Engine contract"): PCM → A/C/Z weighting → exponential time
// weighting (Fast 125 ms, Slow 1 s) → one record per second (7 metrics + flags) and live values for the display.
// Pure TypeScript; all state is carried across buffers, so 1 × 48000 samples and 480 × 100 samples give the same records.
import { createCascadeFilter } from './biquad';
import { createOverloadDetector } from './overload';
import { assertSupportedSampleRate, designWeighting } from './weighting';

export const FLAG_OVERLOAD = 1;
export const FLAG_PARTIAL = 2;
export const FLAG_MIC_BUSY = 4;

export const TAU_FAST = 0.125;
export const TAU_SLOW = 1;

/** One second of levels (dB, estimate = dBFS + offset). Mic-busy seconds (all exact zeros) carry NaN levels. */
export type SecondRecord = {
  /** Start of the second, epoch ms (session clock grid t0 + k·1000). */
  tMs: number;
  laeq: number;
  lceq: number;
  lzeq: number;
  lafmax: number;
  lafmin: number;
  /** LAS at the end of the second. */
  las: number;
  lcpeak: number;
  /** Bit 0 overload, bit 1 partial (< 90 % of its samples), bit 2 mic busy (whole second of zeros). */
  flags: number;
};

export type LiveLevels = { laf: number; las: number; lcf: number; lzf: number; overload: boolean };

export type MeterOptions = {
  fs: number;
  offsetDb: number;
  /** A buffer whose timestamp lies further than this past the expected time starts after a jump (dropped frames). */
  jumpToleranceMs?: number;
};

export type Meter = {
  /**
   * Feeds one buffer of mono samples in [−1, 1]; `tMs` = time of its first sample (monotonic, epoch-aligned ms).
   * Default (`continuous` false): a buffer more than `jumpToleranceMs` later than expected starts after a HOLE (lost
   * frames, pause, interruption): the grid jumps and the meter restarts exactly as at the session start — filters,
   * Fast/Slow detectors and the overload run are reset and LAFmin settles again for 0.5 s (review M2), so no level from
   * before the hole leaks into the seconds after it. Earlier or slightly later buffers keep the grid.
   * `continuous` true: the caller vouches that these samples follow the previous ones without a hole (same frame
   * burst) and only the clock moved (sample-clock drift, capture.ts): the grid is re-aligned to `tMs` (forward, or
   * backward down to the start of the current second) and nothing is reset.
   */
  process(buf: Float32Array | Float64Array | number[], tMs: number, continuous?: boolean): void;
  live(): LiveLevels;
  /** Completed seconds since the last call (oldest first). */
  drainSeconds(): SecondRecord[];
  /** Closes the second in progress (it will usually be partial) so the next drain returns it. */
  flush(): void;
  /** Changes the calibration offset for records and live values from now on. */
  setOffset(offsetDb: number): void;
};

/** 10·log10 with a floor of −200 dB so silence never produces −Infinity. */
export function levelDb(meanSquare: number): number {
  return 10 * Math.log10(Math.max(meanSquare, 1e-20));
}

export function createMeter(options: MeterOptions): Meter {
  const { fs } = options;
  assertSupportedSampleRate(fs); // review S7: below 44.1 kHz the A/C error exceeds A1 (−3.9 dB at 5 kHz for 16 kHz)
  let offset = options.offsetDb;
  const jumpTol = options.jumpToleranceMs ?? 50;
  const fa = createCascadeFilter(designWeighting('A', fs));
  const fc = createCascadeFilter(designWeighting('C', fs));
  const fz = createCascadeFilter(designWeighting('Z', fs)); // flat with DC removal (review S6, D30)
  const overload = createOverloadDetector();
  const alphaF = 1 - Math.exp(-1 / (fs * TAU_FAST));
  const alphaS = 1 - Math.exp(-1 / (fs * TAU_SLOW));
  // LAFmin ignores the first 0.5 s after start: the Fast detector rises from 0 and needs 4τ to settle (−0.08 dB).
  const settleSamples = Math.round(0.5 * fs);
  const partialBelow = 0.9 * fs;

  let t0: number | null = null;
  let pos = 0; // sample position on the session grid (samples since t0)
  let cur = 0; // index of the second being accumulated
  let boundary = fs; // first sample position of the next second
  let total = 0; // samples processed since the start or the last restart after a hole (for settling)
  let lastOverloadTotal = -Infinity;

  let yAF = 0;
  let yAS = 0;
  let yCF = 0;
  let yZF = 0;

  // accumulators of the current second
  let n = 0;
  let sa = 0;
  let sc = 0;
  let sz = 0;
  let maxAF = 0;
  let minAF = Infinity;
  let peakC = 0;
  let nonZero = false;
  let over = false;

  const done: SecondRecord[] = [];

  function resetSecond() {
    n = 0;
    sa = 0;
    sc = 0;
    sz = 0;
    maxAF = 0;
    minAF = Infinity;
    peakC = 0;
    nonZero = false;
    over = false;
  }

  function closeSecond() {
    if (n === 0 || t0 === null) return;
    let flags = 0;
    if (over) flags |= FLAG_OVERLOAD;
    if (n < partialBelow) flags |= FLAG_PARTIAL;
    const tMs = Math.round(t0 + cur * 1000);
    if (!nonZero) {
      flags |= FLAG_MIC_BUSY;
      done.push({ tMs, laeq: NaN, lceq: NaN, lzeq: NaN, lafmax: NaN, lafmin: NaN, las: NaN, lcpeak: NaN, flags });
    } else {
      const min = minAF === Infinity ? yAF : minAF;
      done.push({
        tMs,
        laeq: levelDb(sa / n) + offset,
        lceq: levelDb(sc / n) + offset,
        lzeq: levelDb(sz / n) + offset,
        lafmax: levelDb(maxAF) + offset,
        lafmin: levelDb(min) + offset,
        las: levelDb(yAS) + offset,
        lcpeak: levelDb(peakC * peakC) + offset,
        flags,
      });
    }
    resetSecond();
  }

  function moveTo(newPos: number) {
    const sec = Math.floor(newPos / fs);
    if (sec !== cur) {
      closeSecond();
      cur = sec;
      boundary = (cur + 1) * fs;
    }
    pos = newPos;
  }

  /** After a hole: start again from rest, exactly like the first sample of a session (review M2). */
  function restart() {
    fa.reset();
    fc.reset();
    fz.reset();
    overload.reset();
    yAF = 0;
    yAS = 0;
    yCF = 0;
    yZF = 0;
    total = 0;
    lastOverloadTotal = -Infinity;
  }

  return {
    process(buf, tMs, continuous = false) {
      if (t0 === null) {
        t0 = tMs;
      } else {
        const expected = t0 + (pos * 1000) / fs;
        const target = Math.round(((tMs - t0) * fs) / 1000);
        if (continuous) {
          if (target > pos) moveTo(target);
          else pos = Math.max(target, cur * fs);
        } else if (tMs - expected > jumpTol) {
          moveTo(target);
          restart();
        }
      }
      const len = buf.length;
      for (let i = 0; i < len; i++) {
        const x = buf[i];
        if (pos >= boundary) moveTo(pos);
        const xa = fa.step(x);
        const xc = fc.step(x);
        const xz = fz.step(x);
        const a2 = xa * xa;
        const c2 = xc * xc;
        const z2 = xz * xz;
        sa += a2;
        sc += c2;
        sz += z2;
        yAF += alphaF * (a2 - yAF);
        yAS += alphaS * (a2 - yAS);
        yCF += alphaF * (c2 - yCF);
        yZF += alphaF * (z2 - yZF);
        if (yAF > maxAF) maxAF = yAF;
        if (total >= settleSamples && yAF < minAF) minAF = yAF;
        const axc = xc < 0 ? -xc : xc;
        if (axc > peakC) peakC = axc;
        if (x !== 0) nonZero = true;
        if (overload.step(x)) {
          over = true;
          lastOverloadTotal = total;
        }
        n++;
        pos++;
        total++;
      }
      if (pos >= boundary) moveTo(pos);
    },
    live() {
      return {
        laf: levelDb(yAF) + offset,
        las: levelDb(yAS) + offset,
        lcf: levelDb(yCF) + offset,
        lzf: levelDb(yZF) + offset,
        overload: total - lastOverloadTotal <= fs,
      };
    },
    drainSeconds() {
      return done.splice(0, done.length);
    },
    flush() {
      closeSecond();
      cur = Math.ceil(pos / fs);
      boundary = (cur + 1) * fs;
      pos = cur * fs;
    },
    setOffset(offsetDb: number) {
      offset = offsetDb;
    },
  };
}
