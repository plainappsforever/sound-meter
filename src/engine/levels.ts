// Aggregation of per-second records (SPEC §7.4): energy means, max/min, percentiles, low-frequency hint, background.
import { FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL, type SecondRecord } from './dsp/meter';

export type Gap = { startMs: number; endMs: number; reason: GapReason };
/** `frames-lost`: PCM frames the app did not receive in time (ring overflow while the phone paused the app, D27). */
export type GapReason = 'paused' | 'interruption' | 'mic-busy' | 'app-killed' | 'route-change' | 'frames-lost';

/** WHO 1999 (secondary sources, D26): a C−A difference of MORE than 10 dB suggests low-frequency content. */
export const LF_HINT_THRESHOLD_DB = 10;

/** A record that carries levels: not mic-busy and finite LAeq. */
export function isValid(r: SecondRecord): boolean {
  return (r.flags & FLAG_MIC_BUSY) === 0 && Number.isFinite(r.laeq);
}

/** Energy mean of levels in dB: 10·log10(mean of 10^(L/10)). NaN for an empty list. */
export function energyMean(levels: readonly number[]): number {
  if (levels.length === 0) return NaN;
  // Factor out the maximum for numerical range (levels up to ~200 dB would overflow nothing, but stay exact anyway).
  let max = -Infinity;
  for (const l of levels) if (l > max) max = l;
  let sum = 0;
  for (const l of levels) sum += 10 ** ((l - max) / 10);
  return max + 10 * Math.log10(sum / levels.length);
}

/** Energy mean weighted by durations (seconds): LAeq,T over segments. */
export function energyMeanWeighted(parts: readonly { level: number; seconds: number }[]): number {
  const total = parts.reduce((s, p) => s + p.seconds, 0);
  if (total <= 0) return NaN;
  let max = -Infinity;
  for (const p of parts) if (p.seconds > 0 && p.level > max) max = p.level;
  let sum = 0;
  for (const p of parts) sum += p.seconds * 10 ** ((p.level - max) / 10);
  return max + 10 * Math.log10(sum / total);
}

/** Rounds to 0.1 dB, half away from zero (the codec's resolution, SPEC §7.9). */
export function round1(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 10)) / 10;
}

/**
 * Level exceeded N % of the time, nearest rank (SPEC §7.4): sort ascending, LN = v[ceil((100 − N)/100 · n) − 1],
 * index clamped to ≥ 0, values at 0.1-dB resolution.
 */
export function percentileLN(values: readonly number[], n: number): number {
  if (values.length === 0) return NaN;
  const v = values.map(round1).sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(((100 - n) / 100) * v.length) - 1);
  return v[Math.min(idx, v.length - 1)];
}

export type LfHint = { diffDb: number; strong: boolean };

export function lfHint(lceq: number, laeq: number): LfHint {
  const diffDb = lceq - laeq;
  return { diffDb, strong: Number.isFinite(diffDb) && diffDb > LF_HINT_THRESHOLD_DB };
}

export type Summary = {
  laeq: number;
  lceq: number;
  lzeq: number;
  lafmax: number;
  lafmin: number;
  lcpeak: number;
  lasmax: number;
  l10: number;
  l50: number;
  l90: number;
  lf: LfHint;
  /** Valid seconds × 1000. */
  validMs: number;
  /** Length of the UNION of the gaps (overlapping rows count once), clipped to the session span when one is given. */
  gapMs: number;
  overloadS: number;
  partialS: number;
  micBusyS: number;
  firstMs: number | null;
  /** End of the last record (its tMs + 1000). */
  lastMs: number | null;
};

export type Interval = { startMs: number; endMs: number };

/** Sorted union of intervals; empty ones are dropped, overlapping and touching ones merged. */
export function unionIntervals(xs: readonly Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.endMs > x.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.startMs <= last.endMs) last.endMs = Math.max(last.endMs, x.endMs);
    else out.push({ startMs: x.startMs, endMs: x.endMs });
  }
  return out;
}

/** The parts of `a` that no interval of `cover` covers (sorted). */
export function subtractIntervals(a: Interval, cover: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let from = a.startMs;
  for (const c of unionIntervals(cover)) {
    if (c.endMs <= from) continue;
    if (c.startMs >= a.endMs) break;
    if (c.startMs > from) out.push({ startMs: from, endMs: c.startMs });
    from = Math.max(from, c.endMs);
  }
  if (from < a.endMs) out.push({ startMs: from, endMs: a.endMs });
  return out;
}

/** Missing time of a session (review S2): the union of its gaps, clipped to `span` when given. */
export function gapTotalMs(gaps: readonly Interval[], span?: Interval): number {
  const clipped = span
    ? gaps.map((g) => ({ startMs: Math.max(g.startMs, span.startMs), endMs: Math.min(g.endMs, span.endMs) }))
    : gaps;
  return unionIntervals(clipped).reduce((s, g) => s + (g.endMs - g.startMs), 0);
}

/** Fast membership test "t lies inside a gap" (sorted union + binary search; review N5). */
export function gapLookup(gaps: readonly Interval[]): (t: number) => boolean {
  const u = unionIntervals(gaps);
  return (t: number) => {
    let lo = 0;
    let hi = u.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < u[mid].startMs) hi = mid - 1;
      else if (t >= u[mid].endMs) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

/**
 * Session or event summary over valid seconds; seconds inside gaps are excluded (SPEC §7.4). `span` = the session's
 * [start, end): the gap total is clipped to it.
 */
export function aggregate(records: readonly SecondRecord[], gaps: readonly Gap[] = [], span?: Interval): Summary {
  const inGap = gapLookup(gaps);
  const valid = records.filter((r) => isValid(r) && !inGap(r.tMs));
  const laeqs = valid.map((r) => r.laeq);
  // Loops, not Math.max(...xs): a 24-h session has 86 400 values (too many call arguments for some engines).
  const max = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), xs.length ? -Infinity : NaN);
  const min = (xs: number[]) => xs.reduce((m, x) => (x < m ? x : m), xs.length ? Infinity : NaN);
  const laeq = energyMean(laeqs);
  const lceq = energyMean(valid.map((r) => r.lceq));
  const gapMs = gapTotalMs(gaps, span);
  return {
    laeq,
    lceq,
    lzeq: energyMean(valid.map((r) => r.lzeq)),
    lafmax: max(valid.map((r) => r.lafmax)),
    lafmin: min(valid.map((r) => r.lafmin)),
    lcpeak: max(valid.map((r) => r.lcpeak)),
    lasmax: max(valid.map((r) => r.las)),
    l10: percentileLN(laeqs, 10),
    l50: percentileLN(laeqs, 50),
    l90: percentileLN(laeqs, 90),
    lf: lfHint(lceq, laeq),
    validMs: valid.length * 1000,
    gapMs,
    overloadS: valid.filter((r) => r.flags & FLAG_OVERLOAD).length,
    partialS: valid.filter((r) => r.flags & FLAG_PARTIAL).length,
    micBusyS: records.filter((r) => r.flags & FLAG_MIC_BUSY).length,
    firstMs: records.length ? records[0].tMs : null,
    lastMs: records.length ? records[records.length - 1].tMs + 1000 : null,
  };
}

/** Background B = L90 of the valid LAeq,1s values outside the given intervals (events) (SPEC §7.4). */
export function backgroundL90(
  records: readonly SecondRecord[],
  events: readonly { startMs: number; endMs: number }[],
  gaps: readonly Gap[] = []
): number {
  const inGap = gapLookup(gaps);
  const inEvent = gapLookup(events);
  const outside = records.filter((r) => isValid(r) && !inGap(r.tMs) && !inEvent(r.tMs));
  return percentileLN(
    outside.map((r) => r.laeq),
    90
  );
}
