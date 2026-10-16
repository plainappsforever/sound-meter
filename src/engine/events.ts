// Night-log event detection (SPEC §7.7, D21, D29). Pure, deterministic, re-runnable on the stored 1-s series.
//  1. Running background B(t) = L90 of the valid LAeq,1s values in the preceding 600 s [t − 600 s, t − 1 s] (the
//     current second is NOT in the window, D29 c) that are not inside an event; needs ≥ 60 such values. Before the
//     first 60 there is no B ("warming up": no events).
//  2. A second is loud when LAFmax,1s ≥ B + Δ and LAFmax,1s ≥ 35 dB(A). Δ: High 6, Normal 10, Low 15 dB.
//  3. Loud seconds separated by ≤ 10 quiet seconds merge into one event; the event ends after its last loud second
//     (end = last + 1 s); a gap or a missing/invalid second ends an event. The first and last 10 s of a session never
//     START an event (handling the phone).
//  Decisions of fix round 1 (D29, orchestrator):
//  (a) B HOLDS its last value while an event is open, so an event is never cut by the window; whenever the window
//      holds < 60 values after B was once defined (after a long event or a long gap), the last B is held too.
//      Events longer than 10 min are "long events"; inside one, a sub-event at least 10 dB above the event's OWN
//      running level (the same rule applied to the event's own seconds) is reported as a nested peak (review S1).
//  (b) Quiet seconds inside a merged event count as inside the event (they never enter B); the quiet tail after the
//      last loud second rejoins the background when the event closes.
//  (c) The 600-s window excludes the current second.
// Loud seconds that cannot start an event (warm-up, first/last 10 s) count as background.
import type { SecondRecord } from './dsp/meter';
import { FLAG_OVERLOAD } from './dsp/meter';
import { energyMean, gapLookup, isValid, lfHint, round1, type Gap } from './levels';

export type Sensitivity = 'high' | 'normal' | 'low';
export const SENSITIVITY_DB: Record<Sensitivity, number> = { high: 6, normal: 10, low: 15 };
export const EVENT_FLOOR_DB = 35;
export const BACKGROUND_WINDOW_S = 600;
export const BACKGROUND_MIN_VALID = 60;
export const MERGE_QUIET_S = 10;
export const EDGE_S = 10;
export const MARK_HALF_S = 30;
/** D29 (a): an event longer than this is a "long event" and gets nested-peak detection. */
export const LONG_EVENT_S = 600;
/** D29 (a): a nested peak is at least this far above the long event's own running level. */
export const NESTED_PEAK_DB = 10;

export type EventMetrics = {
  laeq: number;
  lafmax: number;
  lcpeak: number;
  lceq: number;
  lfHint: boolean;
  overloadS: number;
};

export type EventCandidate = EventMetrics & {
  startMs: number;
  endMs: number;
  /** B at the event's start (held while it is open); for a nested peak: the long event's running level. */
  backgroundDb: number;
  /** Longer than LONG_EVENT_S (D29 a). */
  long: boolean;
  /** Nested peaks of a long event (empty otherwise; peaks have no peaks of their own). Stored as auto events inside it. */
  peaks: EventCandidate[];
};

export type DetectOptions = {
  sensitivity: Sensitivity;
  /** Session span; defaults to the first record's start and the last record's end. */
  sessionStartMs?: number;
  sessionEndMs?: number;
};

/** Histogram of 0.1-dB bins (−100 … +250 dB) with a Fenwick tree: O(log n) insert/remove/rank for the running L90. */
class LevelHistogram {
  private static readonly MIN = -1000; // tenths of dB
  private static readonly SIZE = 3501;
  private tree = new Int32Array(LevelHistogram.SIZE + 1);
  count = 0;

  private bin(level: number): number {
    const t = Math.round(round1(level) * 10);
    return Math.max(0, Math.min(LevelHistogram.SIZE - 1, t - LevelHistogram.MIN));
  }

  add(level: number, delta: 1 | -1) {
    this.count += delta;
    for (let i = this.bin(level) + 1; i <= LevelHistogram.SIZE; i += i & -i) this.tree[i] += delta;
  }

  /** k-th smallest value (k from 1). */
  kth(k: number): number {
    let pos = 0;
    let rem = k;
    for (let step = 1 << 12; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= LevelHistogram.SIZE && this.tree[next] < rem) {
        pos = next;
        rem -= this.tree[next];
      }
    }
    return (pos + LevelHistogram.MIN) / 10;
  }

  /** LN by the SPEC nearest-rank rule: v[ceil((100 − N)/100 · n) − 1] (0-based) = kth(max(1, ceil(...))). */
  ln(n: number): number {
    if (this.count === 0) return NaN;
    return this.kth(Math.max(1, Math.ceil(((100 - n) / 100) * this.count)));
  }
}

/** Metrics of the records in [startMs, endMs). */
export function eventMetrics(records: readonly SecondRecord[], startMs: number, endMs: number): EventMetrics {
  const inside = records.filter((r) => r.tMs >= startMs && r.tMs < endMs && isValid(r));
  const laeq = energyMean(inside.map((r) => r.laeq));
  const lceq = energyMean(inside.map((r) => r.lceq));
  return {
    laeq,
    lceq,
    lafmax: inside.reduce((m, r) => (r.lafmax > m ? r.lafmax : m), inside.length ? -Infinity : NaN),
    lcpeak: inside.reduce((m, r) => (r.lcpeak > m ? r.lcpeak : m), inside.length ? -Infinity : NaN),
    lfHint: lfHint(lceq, laeq).strong,
    overloadS: inside.filter((r) => r.flags & FLAG_OVERLOAD).length,
  };
}

type Run = { first: number; last: number; b: number };

/**
 * The detection core on a grid of seconds (index i = one second; null = missing, invalid or in a gap), used for the
 * session (Δ = sensitivity) and, with Δ = 10 dB, for the seconds of a long event (nested peaks).
 * Returns runs [first, last] of loud seconds (last = index of the last loud second).
 */
function scan(slots: readonly (SecondRecord | null)[], delta: number, canStart: (i: number) => boolean): Run[] {
  const hist = new LevelHistogram();
  const window: { i: number; v: number }[] = []; // background values in time order
  let head = 0;
  const add = (i: number, v: number) => {
    window.push({ i, v });
    hist.add(v, 1);
  };
  const out: Run[] = [];
  let open: { first: number; last: number; b: number; pending: number[] } | null = null;
  let heldB = NaN; // last defined B (D29 a)

  const close = () => {
    if (!open) return;
    out.push({ first: open.first, last: open.last, b: open.b });
    for (const i of open.pending) add(i, slots[i]!.laeq); // quiet tail rejoins the background (D29 b)
    open = null;
  };

  for (let i = 0; i < slots.length; i++) {
    const r = slots[i];
    if (!r) {
      close();
      continue;
    }
    // window [i − 600, i − 1] (D29 c): values older than 600 s leave before the current second is judged
    while (head < window.length && window[head].i < i - BACKGROUND_WINDOW_S) hist.add(window[head++].v, -1);
    if (open) {
      if (r.lafmax >= open.b + delta && r.lafmax >= EVENT_FLOOR_DB) {
        open.last = i;
        open.pending = [];
      } else {
        open.pending.push(i);
        if (open.pending.length > MERGE_QUIET_S) close();
      }
      continue;
    }
    if (hist.count >= BACKGROUND_MIN_VALID) heldB = hist.ln(90);
    const b = heldB;
    const loud = Number.isFinite(b) && r.lafmax >= b + delta && r.lafmax >= EVENT_FLOOR_DB;
    if (loud && canStart(i)) open = { first: i, last: i, b, pending: [] };
    else add(i, r.laeq);
  }
  close();
  return out;
}

export function detectEvents(
  records: readonly SecondRecord[],
  gaps: readonly Gap[],
  options: DetectOptions
): EventCandidate[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((a, b) => a.tMs - b.tMs);
  const end = options.sessionEndMs ?? sorted[sorted.length - 1].tMs + 1000;
  // Review S5: walk the grid of the RECORDS. A session start that is off the records' 1-s grid (an import, a native
  // D19 path, rounding) is snapped forward to the first record's phase. (Records themselves are on one grid: the
  // meter and the codec guarantee it; they are placed by rounding to the nearest grid second.)
  const given = options.sessionStartMs ?? sorted[0].tMs;
  const start = given + ((((sorted[0].tMs - given) % 1000) + 1000) % 1000);
  const n = Math.max(0, Math.ceil((end - start) / 1000));
  const delta = SENSITIVITY_DB[options.sensitivity];
  const inGap = gapLookup(gaps);
  const slots: (SecondRecord | null)[] = new Array(n).fill(null);
  for (const r of sorted) {
    const i = Math.round((r.tMs - start) / 1000);
    if (i >= 0 && i < n && isValid(r) && !inGap(start + i * 1000)) slots[i] = r;
  }
  const t = (i: number) => start + i * 1000;
  const canStart = (i: number) => t(i) >= given + EDGE_S * 1000 && t(i) < end - EDGE_S * 1000;

  const candidate = (s: number, e: number, b: number, peaks: EventCandidate[]): EventCandidate => ({
    startMs: s,
    endMs: e,
    backgroundDb: b,
    long: e - s > LONG_EVENT_S * 1000,
    peaks,
    ...eventMetrics(sorted, s, e),
  });

  return scan(slots, delta, canStart).map((run) => {
    const s = t(run.first);
    const e = t(run.last + 1);
    let peaks: EventCandidate[] = [];
    if (e - s > LONG_EVENT_S * 1000) {
      // D29 (a): the long event's own seconds, with its own running level (same rule, Δ = 10 dB, no edge rule)
      const inner = slots.slice(run.first, run.last + 1);
      peaks = scan(inner, NESTED_PEAK_DB, () => true).map((p) => candidate(t(run.first + p.first), t(run.first + p.last + 1), p.b, []));
    }
    return candidate(s, e, run.b, peaks);
  });
}

/** All candidates flat (top-level events and their nested peaks), in time order — what finalise stores. */
export function flattenCandidates(events: readonly EventCandidate[]): EventCandidate[] {
  return events.flatMap((e) => [e, ...e.peaks]).sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
}

/**
 * Stored events → which are nested peaks (D29 a). A stored auto event lying inside a LONG auto event (> 10 min) is that
 * event's nested peak; it is listed under it and not counted as an event of its own. Returns child id → parent.
 */
export function nestedPeaks<T extends { id: number; source: string; startMs: number; endMs: number }>(events: readonly T[]): Map<number, T> {
  const longs = events.filter((e) => e.source === 'auto' && e.endMs - e.startMs > LONG_EVENT_S * 1000);
  const out = new Map<number, T>();
  for (const e of events) {
    if (e.source !== 'auto') continue;
    const parent = longs.find((p) => p.id !== e.id && p.startMs <= e.startMs && e.endMs <= p.endMs && p.endMs - p.startMs > e.endMs - e.startMs);
    if (parent) out.set(e.id, parent);
  }
  return out;
}

/** A "Mark now" interval [t − 30 s, t + 30 s] clipped to the session, with its metrics (SPEC §7.7 step 6). */
export function markEvent(
  records: readonly SecondRecord[],
  tMs: number,
  sessionStartMs: number,
  sessionEndMs: number
): EventMetrics & { startMs: number; endMs: number } {
  const startMs = Math.max(sessionStartMs, tMs - MARK_HALF_S * 1000);
  const endMs = Math.min(sessionEndMs, tMs + MARK_HALF_S * 1000);
  return { startMs, endMs, ...eventMetrics(records, startMs, endMs) };
}

/** The user-editable part of a stored event. */
export type EventLabels = {
  category: string | null;
  categoryOther: string;
  note: string;
  witnesses: string;
  effect: string | null;
  excluded: boolean;
};

export type StoredEventRef = EventLabels & { id: number; source: 'auto' | 'mark' | 'manual'; startMs: number; endMs: number };

export function isLabelled(e: EventLabels): boolean {
  return (
    e.category !== null ||
    e.categoryOther.trim() !== '' ||
    e.note.trim() !== '' ||
    e.witnesses.trim() !== '' ||
    e.effect !== null ||
    e.excluded
  );
}

/**
 * "Re-detect with another sensitivity" (SPEC §7.7 step 5): unlabelled auto events are removed; labelled auto events are
 * kept and become marks; marks and manual entries stay. New candidates that overlap a kept event are dropped (D27), so
 * the user's labels are never duplicated.
 */
export function planRedetect(existing: readonly StoredEventRef[], candidates: readonly EventCandidate[]) {
  const removeIds: number[] = [];
  const convertToMarkIds: number[] = [];
  const kept: { startMs: number; endMs: number }[] = [];
  for (const e of existing) {
    if (e.source === 'auto' && !isLabelled(e)) removeIds.push(e.id);
    else {
      if (e.source === 'auto') convertToMarkIds.push(e.id);
      kept.push(e);
    }
  }
  const insert = candidates.filter((c) => !kept.some((k) => c.startMs < k.endMs && k.startMs < c.endMs));
  return { removeIds, convertToMarkIds, insert };
}
