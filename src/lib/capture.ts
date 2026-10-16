// Capture pipeline glue (V1_PLAN Architecture "src/lib/capture.ts"): PCM chunks from modules/mic-pcm → meter →
// per-second records → minute blocks; capture events → log state machine → gaps. No native imports: the recorder
// service of P3/P5 subscribes to the module (push events or read() polling) and calls push()/event(); writes go through
// the callbacks (blocks via withWrite in src/db/blocks.ts, gaps via openGap/closeGap in src/db/gaps.ts).
// Tested in Node with modules/mic-pcm/src/fake.ts.
// Audio never leaves this function: chunks are processed and dropped; only levels are passed on (D13).
//
// Timing (fix round 1, review M1; contract in MicPcm.types.ts PcmChunk): time comes from the chunk's monotonic tMs,
// anchored ONCE per frame burst — never from the frame counter alone. Inside a burst frame times follow the sample
// clock; 50 ms–1 s of disagreement is drift (anchor moves, no hole); anything else starts a new burst. A burst that
// starts after the audio already accounted for leaves a hole: the meter restarts (M2) and the part of the hole that no
// gap explains becomes a `frames-lost` gap — never a duplicate of an interruption or pause. Frames older than the
// session start (ring backlog) or already covered are dropped.
import type { PcmChunk } from '../../modules/mic-pcm/src/MicPcm.types';

import { createBlockAccumulator, type EncodedBlock } from '@/engine/codec';
import { createMeter, FLAG_MIC_BUSY, type LiveLevels, type Meter, type SecondRecord } from '@/engine/dsp/meter';
import { isSupportedSampleRate } from '@/engine/dsp/weighting';
import { subtractIntervals, type Gap, type GapReason, type Interval } from '@/engine/levels';
import { CAUSE_REASON, GAP_CAUSES, logReducer, startLog, type LogEvent, type LogState } from '@/engine/session';

/** Within a burst, |tMs − sample-clock time| up to this is jitter: the sample clock is kept. */
export const DRIFT_TOLERANCE_MS = 50;
/** Within a burst, a larger difference than this is a hidden break (framePos ran on while time jumped): new burst. */
export const BURST_BREAK_MS = 1000;
/** Uncovered holes shorter than this are not reported (the meter does not see them either). */
export const MIN_LOST_MS = 50;

export type CapturePipelineOptions = {
  /** Rate at start (StartResult.sampleRate); chunks carry their own rate and may change it. */
  sampleRate: number;
  offsetDb: number;
  /** Grid origin of the session's seconds (sessions.started_at). */
  sessionStartMs: number;
  onBlock: (block: EncodedBlock) => void;
  /**
   * A closed gap. With `onGapOpen` set, every gap that was reported open is closed here, also one that ended at its own
   * start (then endMs === startMs: drop the open row).
   */
  onGap: (gap: Gap) => void;
  /** A gap has begun (store it at once, review S4); `onGap` closes it later. frames-lost gaps are never open. */
  onGapOpen?: (gap: { startMs: number; reason: GapReason }) => void;
  onRecords?: (records: SecondRecord[]) => void;
};

export type CapturePipeline = {
  push(chunk: PcmChunk): void;
  /** Interruption / route / pause / stop events (engine session.ts). */
  event(e: LogEvent): void;
  live(): LiveLevels;
  /** The block in progress (write it with each heartbeat so a crash loses ≤ 60 s). */
  pendingBlock(): EncodedBlock | null;
  /** Ends capture at time t: flushes the last second and block, closes open gaps. */
  finish(t: number): void;
  state(): LogState;
  setOffset(offsetDb: number): void;
};

export function createCapturePipeline(o: CapturePipelineOptions): CapturePipeline {
  let fs = o.sampleRate;
  let offset = o.offsetDb;
  const silent: LiveLevels = { laf: NaN, las: NaN, lcf: NaN, lzf: NaN, overload: false };
  const newMeter = (): Meter | null => {
    if (!isSupportedSampleRate(fs)) return null;
    const m = createMeter({ fs, offsetDb: offset });
    m.process(new Float32Array(0), o.sessionStartMs); // grid origin = session start; the first second is partial
    return m;
  };
  let meter = newMeter();
  const acc = createBlockAccumulator(o.sessionStartMs);
  let log = startLog(o.sessionStartMs);
  let anchor: { framePos: number; tMs: number } | null = null;
  let nextFrame: number | null = null;
  let nextMs = o.sessionStartMs; // end of the audio already accounted for (measured, paused or covered)
  let started = false;
  let fedLast = false; // the meter saw the previous chunk (else the next one is a hole for it)
  let micBusy = false;

  const apply = (e: LogEvent) => {
    const before = log;
    log = logReducer(log, e);
    const added = log.gaps.slice(before.gaps.length);
    for (const c of GAP_CAUSES) {
      const was = before.open[c];
      const now = log.open[c];
      if (was !== undefined && now === undefined) {
        const g = added.find((x) => x.startMs === was && x.reason === CAUSE_REASON[c]);
        if (g) o.onGap(g);
        else if (o.onGapOpen) o.onGap({ startMs: was, endMs: was, reason: CAUSE_REASON[c] });
      }
      if (now !== undefined && was === undefined) o.onGapOpen?.({ startMs: now, reason: CAUSE_REASON[c] });
    }
  };
  if (!meter) apply({ type: 'format-unsupported', t: o.sessionStartMs });

  /** Time that a gap already explains: every closed gap plus every open cause up to "now". */
  const covered = (): Interval[] => [
    ...log.gaps,
    ...GAP_CAUSES.filter((c) => log.open[c] !== undefined).map((c) => ({ startMs: log.open[c]!, endMs: Infinity })),
  ];

  const handleRecords = (records: SecondRecord[]) => {
    for (const r of records) {
      const busy = (r.flags & FLAG_MIC_BUSY) !== 0;
      if (busy && !micBusy) apply({ type: 'mic-busy', t: r.tMs });
      if (!busy && micBusy) apply({ type: 'mic-back', t: r.tMs });
      micBusy = busy;
    }
    for (const b of acc.add(records)) o.onBlock(b);
    if (records.length) o.onRecords?.(records);
  };

  const drain = () => {
    if (meter) handleRecords(meter.drainSeconds());
  };

  /** Format change (review S7): the meter is rebuilt for the new rate; an unsupported rate is a route-change gap. */
  const changeRate = (rate: number, t: number) => {
    if (meter) {
      meter.flush();
      drain();
    }
    fs = rate;
    meter = newMeter();
    anchor = null;
    fedLast = false;
    if (!meter) apply({ type: 'format-unsupported', t });
    else if (log.open.format !== undefined) apply({ type: 'format-ok', t });
  };

  return {
    push(chunk) {
      if (log.phase === 'finished') return;
      const rate = chunk.sampleRate ?? fs;
      if (rate !== fs) changeRate(rate, Math.max(nextMs, chunk.tMs));
      const contiguous = anchor !== null && !chunk.discontinuity && chunk.dropped === 0 && chunk.framePos === nextFrame;
      const predicted = anchor ? anchor.tMs + ((chunk.framePos - anchor.framePos) * 1000) / fs : NaN;
      const diff = Math.abs(chunk.tMs - predicted);
      let t: number;
      let sameBurst: boolean;
      if (contiguous && diff <= DRIFT_TOLERANCE_MS) {
        t = predicted;
        sameBurst = true;
      } else if (contiguous && diff <= BURST_BREAK_MS) {
        anchor = { framePos: chunk.framePos, tMs: chunk.tMs }; // drift: the clock moved, the audio did not break
        t = chunk.tMs;
        sameBurst = true;
      } else {
        anchor = { framePos: chunk.framePos, tMs: chunk.tMs }; // new burst
        t = chunk.tMs;
        sameBurst = false;
      }
      nextFrame = chunk.framePos + chunk.data.length;

      let data = chunk.data;
      if (!sameBurst && t < nextMs) {
        // backlog older than the session start, or a restart that overlaps time already accounted for
        const skip = Math.min(data.length, Math.ceil(((nextMs - t) * fs) / 1000 - 1e-6));
        data = data.subarray(skip);
        t += (skip * 1000) / fs;
      }
      if (!sameBurst && started && t - nextMs > MIN_LOST_MS) {
        for (const piece of subtractIntervals({ startMs: nextMs, endMs: t }, covered()))
          if (piece.endMs - piece.startMs > MIN_LOST_MS)
            o.onGap({ startMs: Math.round(piece.startMs), endMs: Math.round(piece.endMs), reason: 'frames-lost' });
      }
      if (data.length === 0) return;
      started = true;
      // Paused = the user asked us not to measure: audio is discarded. In every other gap we keep measuring, so the
      // end of a mic-busy stretch is seen; seconds inside gaps are excluded from summaries, events, chart and CSV.
      const feed = log.phase !== 'paused' && meter !== null;
      if (feed) meter!.process(data, t, sameBurst && fedLast);
      fedLast = feed;
      nextMs = Math.max(nextMs, t + (data.length * 1000) / fs);
      drain();
    },
    event(e) {
      apply(e);
    },
    live: () => (meter ? meter.live() : silent),
    pendingBlock: () => acc.pending(),
    finish(t) {
      if (meter) {
        meter.flush();
        drain();
      }
      const p = acc.pending();
      if (p) o.onBlock(p);
      apply({ type: 'stop', t });
    },
    state: () => log,
    setOffset: (offsetDb) => {
      offset = offsetDb;
      meter?.setOffset(offsetDb);
    },
  };
}
