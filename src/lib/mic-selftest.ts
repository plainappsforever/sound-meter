// P3 spike self-test (dev builds): drives the REAL native capture module (or the Node fake in Jest) through the real
// pipeline (src/lib/capture.ts) and measures what the spike must report — level chain (A8), timing contract, frame
// accounting, interruptions, JS cost on Hermes, background coverage (A9). Every wait is driven by arriving audio, not by
// JS timers, so a run also proves that JS keeps receiving buffers with the screen off (D19).
// Levels only leave this file; PCM chunks are processed and dropped (D13).
import type { MicPcm, PcmChunk, StartOptions, StartResult, Subscription, SyntheticSpec } from '../../modules/mic-pcm/src/MicPcm.types';
import type { MicPcmDebug } from '../../modules/mic-pcm/src/MicPcmModule';

import { createCapturePipeline, type CapturePipeline } from './capture';

import { DEFAULT_OFFSET_DB } from '@/engine/calibration';
import type { EncodedBlock } from '@/engine/codec';
import { createMeter, FLAG_PARTIAL, type SecondRecord } from '@/engine/dsp/meter';
import { energyMean, type Gap } from '@/engine/levels';

export type SelftestMic = MicPcm & { debug?: MicPcmDebug };

/** E1 (SPEC §7.10, Android CDD 5.11): 1 kHz at RMS 520/32768 = −35.99 dBFS reads 94.0 dB with the default offset. */
export const E1_RMS_DBFS = 20 * Math.log10(520 / 32768);
export const E1_SPEC: SyntheticSpec = { kind: 'sine', hz: 1000, rmsDbfs: E1_RMS_DBFS };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** What one capture run saw (all numbers are about delivery, none is audio). */
export type Probe = {
  chunks: number;
  frames: number;
  minChunk: number;
  maxChunk: number;
  dropped: number;
  discontinuities: number;
  bursts: number;
  /** max |tMs − prediction from the burst's first chunk| over contiguous chunks (timestamp jitter + drift). */
  maxJitterMs: number;
  /** drift of the capture clock vs the sample clock over the longest burst, ppm. */
  driftPpm: number;
  /** framePos/tMs at every break (discontinuity, drop, framePos jump) — the contract's "framePos behaviour". */
  breaks: { framePos: number; expectedFramePos: number | null; tMs: number; dropped: number; disc: boolean }[];
  /** ms spent in pipeline.push (meter + blocks), and seconds of audio it covered. */
  jsMs: number;
  audioS: number;
  /** delivery latency: Date.now() at arrival − capture time of the chunk's last frame (max and mean). */
  maxLatencyMs: number;
  meanLatencyMs: number;
  /** chunks that arrived while the app was in the background (AppState, filled by the caller). */
  backgroundChunks: number;
  meanDc: number;
};

function newProbe(): Probe {
  return {
    chunks: 0, frames: 0, minChunk: Infinity, maxChunk: 0, dropped: 0, discontinuities: 0, bursts: 0, maxJitterMs: 0,
    driftPpm: 0, breaks: [], jsMs: 0, audioS: 0, maxLatencyMs: 0, meanLatencyMs: 0, backgroundChunks: 0, meanDc: 0,
  };
}

export type CaptureRun = {
  start: StartResult;
  probe: Probe;
  records: SecondRecord[];
  gaps: Gap[];
  sessionStartMs: number;
  endMs: number;
  events: { type: string; t: number; detail?: string }[];
};

export type CaptureRunOptions = {
  start?: Partial<StartOptions>;
  synthetic?: SyntheticSpec | null;
  /** Capture-time length of the run, s (also counts time without audio, e.g. an interruption). */
  seconds: number;
  offsetDb?: number;
  onBlock?: (b: EncodedBlock) => void;
  /** Called after each chunk with the elapsed capture time (s) — test hooks (stall, interruption). */
  onTick?: (elapsedS: number, pipe: CapturePipeline) => void;
  isBackground?: () => boolean;
  onProgress?: (elapsedS: number, probe: Probe) => void;
};

/** Starts capture, feeds every pushed chunk through the pipeline until `seconds` of capture time passed, stops. */
export async function captureRun(mic: SelftestMic, o: CaptureRunOptions): Promise<CaptureRun> {
  if (o.synthetic !== undefined) await mic.setSyntheticSource?.(o.synthetic);
  const start = await mic.start({ source: 'auto', bufferMs: 100, ringSeconds: 10, ...o.start });
  const sessionStartMs = Date.now();
  const probe = newProbe();
  const records: SecondRecord[] = [];
  const gaps: Gap[] = [];
  const events: CaptureRun['events'] = [];
  const pipe = createCapturePipeline({
    sampleRate: start.sampleRate,
    offsetDb: o.offsetDb ?? DEFAULT_OFFSET_DB,
    sessionStartMs,
    onBlock: o.onBlock ?? (() => {}),
    onGap: (g) => gaps.push(g),
    onRecords: (r) => records.push(...r),
  });
  const subs: Subscription[] = [];
  subs.push(
    mic.addListener('interruption', (e) => {
      const t = Date.now();
      events.push({ type: `interruption-${e.phase}`, t, detail: e.reason });
      pipe.event({ type: e.phase === 'began' ? 'interruption-began' : 'interruption-ended', t });
    }),
    mic.addListener('route', (e) => {
      events.push({ type: 'route', t: Date.now(), detail: e.route });
      pipe.event({ type: 'route-change', t: Date.now(), builtin: e.builtin });
    }),
    mic.addListener('error', (e) => events.push({ type: 'error', t: Date.now(), detail: `${e.code}: ${e.message}` })),
    mic.addListener('format', (e) => events.push({ type: 'format', t: Date.now(), detail: String(e.sampleRate) })),
  );

  let burst: { framePos: number; tMs: number; rate: number } | null = null;
  let nextPos: number | null = null;
  let latencySum = 0;
  let dcSum = 0;
  let longest = { frames: 0, drift: 0 };
  const endMs = await new Promise<number>((resolve) => {
    let done = false;
    const sub = mic.addListener('buffer', (c: PcmChunk) => {
      if (done) return;
      const arrived = Date.now();
      const n = c.data.length;
      probe.chunks++;
      probe.frames += n;
      probe.minChunk = Math.min(probe.minChunk, n);
      probe.maxChunk = Math.max(probe.maxChunk, n);
      probe.dropped += c.dropped;
      if (c.discontinuity) probe.discontinuities++;
      if (o.isBackground?.()) probe.backgroundChunks++;
      const contiguous = burst !== null && !c.discontinuity && c.dropped === 0 && c.framePos === nextPos && c.sampleRate === burst.rate;
      if (contiguous && burst) {
        const predicted = burst.tMs + ((c.framePos - burst.framePos) * 1000) / c.sampleRate;
        probe.maxJitterMs = Math.max(probe.maxJitterMs, Math.abs(c.tMs - predicted));
        const span = c.framePos - burst.framePos;
        if (span > longest.frames) longest = { frames: span, drift: ((c.tMs - predicted) / ((span * 1000) / c.sampleRate)) * 1e6 };
      } else {
        if (burst !== null) probe.breaks.push({ framePos: c.framePos, expectedFramePos: nextPos, tMs: c.tMs, dropped: c.dropped, disc: !!c.discontinuity });
        burst = { framePos: c.framePos, tMs: c.tMs, rate: c.sampleRate };
        probe.bursts++;
      }
      nextPos = c.framePos + n;
      const lastFrameMs = c.tMs + (n * 1000) / c.sampleRate;
      const lat = arrived - lastFrameMs;
      latencySum += lat;
      probe.maxLatencyMs = Math.max(probe.maxLatencyMs, lat);
      let s = 0;
      for (let i = 0; i < n; i++) s += c.data[i];
      dcSum += s;
      const t0 = now();
      pipe.push(c);
      probe.jsMs += now() - t0;
      probe.audioS += n / c.sampleRate;
      const elapsed = (lastFrameMs - sessionStartMs) / 1000;
      o.onTick?.(elapsed, pipe);
      o.onProgress?.(elapsed, probe);
      if (elapsed >= o.seconds) {
        done = true;
        sub.remove();
        resolve(lastFrameMs);
      }
    });
  });
  subs.forEach((s) => s.remove());
  await mic.stop();
  pipe.finish(endMs);
  probe.meanLatencyMs = probe.chunks ? latencySum / probe.chunks : 0;
  probe.meanDc = probe.frames ? dcSum / probe.frames : 0;
  probe.driftPpm = longest.drift;
  if (!Number.isFinite(probe.minChunk)) probe.minChunk = 0;
  return { start, probe, records, gaps, sessionStartMs, endMs, events };
}

/** Energy mean of the full (non-partial) seconds. */
export function fullSecondsLaeq(records: readonly SecondRecord[]): { laeq: number; min: number; max: number; n: number } {
  const full = records.filter((r) => (r.flags & FLAG_PARTIAL) === 0 && Number.isFinite(r.laeq));
  const xs = full.map((r) => r.laeq);
  return { laeq: energyMean(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/** JS cost: ms of pipeline work per second of audio. */
export const msPerAudioSecond = (p: Probe) => (p.audioS > 0 ? p.jsMs / p.audioS : NaN);

// ---------------------------------------------------------------- A8: E1 through the synthetic source
export type E1Result = { pass: boolean; laeq: number; lceq: number; lzeq: number; min: number; max: number; seconds: number; run: CaptureRun };

export async function runE1(mic: SelftestMic, seconds = 6, extra: Partial<CaptureRunOptions> = {}): Promise<E1Result> {
  const run = await captureRun(mic, { synthetic: E1_SPEC, seconds, ...extra });
  await mic.setSyntheticSource?.(null);
  const a = fullSecondsLaeq(run.records);
  const full = run.records.filter((r) => (r.flags & FLAG_PARTIAL) === 0);
  const lceq = energyMean(full.map((r) => r.lceq));
  const lzeq = energyMean(full.map((r) => r.lzeq));
  const pass = a.n >= 3 && Math.abs(a.laeq - 94) <= 0.1 && Math.abs(lceq - 94) <= 0.1 && Math.abs(lzeq - 94) <= 0.1;
  return { pass, laeq: a.laeq, lceq, lzeq, min: a.min, max: a.max, seconds: a.n, run };
}

// ---------------------------------------------------------------- blind-set signals injected into the native ring
export type InjectFixture = { id: string; fs: number; pcm: Float32Array };
export type InjectResult = {
  id: string;
  fs: number;
  skipped?: string;
  /** samples that differ between what was injected and what came back through ring + transfer (must be 0). */
  mismatches: number;
  frames: number;
  /** records at offset 0, computed exactly like the blind adapter (100-ms buffers from the file start, flush). */
  records: SecondRecord[];
  jsMsPerS: number;
};

/** Injects each fixture (at the running hardware rate) and collects exactly its frames from the pushed chunks. */
export async function runInjected(mic: SelftestMic, fixtures: InjectFixture[]): Promise<{ start: StartResult; results: InjectResult[] }> {
  if (!mic.debug) throw new Error('injectPcm needs a dev build');
  await mic.setSyntheticSource?.({ kind: 'zeros' });
  const start = await mic.start({ source: 'auto', bufferMs: 100, ringSeconds: 10 });
  const results: InjectResult[] = [];
  try {
    for (const fx of fixtures) {
      if (fx.fs !== start.sampleRate) {
        results.push({ id: fx.id, fs: fx.fs, skipped: `hardware rate ${start.sampleRate}`, mismatches: 0, frames: 0, records: [], jsMsPerS: NaN });
        continue;
      }
      const got = new Float32Array(fx.pcm.length);
      const first = mic.debug.injectPcm(fx.pcm);
      let filled = 0;
      let mismatches = 0;
      await new Promise<void>((resolve) => {
        const sub = mic.addListener('buffer', (c) => {
          const from = Math.max(first, c.framePos);
          const to = Math.min(first + fx.pcm.length, c.framePos + c.data.length);
          for (let p = from; p < to; p++) {
            const v = c.data[p - c.framePos];
            got[p - first] = v;
            if (v !== fx.pcm[p - first] && !(Number.isNaN(v) && Number.isNaN(fx.pcm[p - first]))) mismatches++;
            filled++;
          }
          if (c.framePos + c.data.length >= first + fx.pcm.length) {
            sub.remove();
            resolve();
          }
        });
      });
      const t0 = now();
      const meter = createMeter({ fs: fx.fs, offsetDb: 0 });
      const buf = Math.round(fx.fs / 10);
      const T0 = Date.UTC(2026, 9, 16, 22, 0, 0);
      for (let i = 0; i < got.length; i += buf) meter.process(got.subarray(i, Math.min(got.length, i + buf)), T0 + (i * 1000) / fx.fs);
      meter.flush();
      const records = meter.drainSeconds().map((r) => ({ ...r, tMs: Math.round((r.tMs - T0) / 1000) }));
      results.push({ id: fx.id, fs: fx.fs, mismatches: mismatches + (fx.pcm.length - filled), frames: filled, records, jsMsPerS: (now() - t0) / (got.length / fx.fs) });
    }
  } finally {
    await mic.stop();
    await mic.setSyntheticSource?.(null);
  }
  return { start, results };
}

/** Minimal mono IEEE-float32 WAV reader (format tag 3 / extensible), for the dev-only fixture assets. */
export function parseWavF32(buf: ArrayBuffer): { fs: number; x: Float32Array } {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let fs = 0;
  let x: Float32Array | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      const fmt = v.getUint16(body, true);
      const ch = v.getUint16(body + 2, true);
      fs = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if ((fmt !== 3 && fmt !== 0xfffe) || ch !== 1 || bits !== 32) throw new Error('expected mono float32');
    } else if (id === 'data') {
      x = new Float32Array(size / 4);
      for (let i = 0; i < x.length; i++) x[i] = v.getFloat32(body + 4 * i, true);
    }
    off = body + size + (size & 1);
  }
  if (!x || !fs) throw new Error('no data');
  return { fs, x };
}

// ---------------------------------------------------------------- interruption and frames-lost
export type GapCheck = { pass: boolean; detail: string; run: CaptureRun };

/** Interruption through the platform's own handler path (iOS notification; Android silenced-client callback). */
export async function runInterruption(mic: SelftestMic, beganAtS = 3, lengthS = 5, totalS = 12): Promise<GapCheck> {
  if (!mic.debug) throw new Error('needs a dev build');
  const debug = mic.debug;
  let fired = false;
  const run = await captureRun(mic, {
    synthetic: { kind: 'sine', hz: 1000, rmsDbfs: -70 },
    seconds: totalS,
    onTick: (elapsed) => {
      if (!fired && elapsed >= beganAtS) {
        fired = true;
        debug.interruption(true);
        setTimeout(() => debug.interruption(false), lengthS * 1000);
      }
    },
  });
  await mic.setSyntheticSource?.(null);
  const gap = run.gaps.find((g) => g.reason === 'interruption');
  const len = gap ? (gap.endMs - gap.startMs) / 1000 : 0;
  const lost = run.gaps.filter((g) => g.reason === 'frames-lost');
  const pass = !!gap && Math.abs(len - lengthS) < 0.6 && lost.length === 0;
  return { pass, detail: `interruption gap ${len.toFixed(2)} s (expected ${lengthS}), frames-lost gaps ${lost.length}`, run };
}

/** Blocks the JS thread for `stallS` (longer than the ring holds): the loss must come back as ONE frames-lost gap. */
export async function runFramesLost(mic: SelftestMic, ringSeconds = 2, stallS = 5, totalS = 12): Promise<GapCheck & { droppedMs: number; lostMs: number }> {
  let stalled = false;
  const run = await captureRun(mic, {
    start: { ringSeconds },
    synthetic: { kind: 'sine', hz: 1000, rmsDbfs: -50 },
    seconds: totalS,
    onTick: (elapsed) => {
      if (!stalled && elapsed >= 3) {
        stalled = true;
        const until = Date.now() + stallS * 1000;
        while (Date.now() < until) {
          /* busy: the JS thread is "frozen" */
        }
      }
    },
  });
  await mic.setSyntheticSource?.(null);
  const lost = run.gaps.filter((g) => g.reason === 'frames-lost');
  const lostMs = lost.reduce((s, g) => s + g.endMs - g.startMs, 0);
  const droppedMs = (run.probe.dropped * 1000) / run.start.sampleRate;
  const pass = lost.length === 1 && run.probe.dropped > 0 && Math.abs(lostMs - droppedMs) <= 60;
  return { pass, detail: `dropped ${droppedMs.toFixed(0)} ms in ${run.probe.breaks.length} break(s); frames-lost gaps ${lost.length} = ${lostMs} ms`, run, droppedMs, lostMs };
}

// ---------------------------------------------------------------- pull delivery cost (read 'oldest' / 'newest')
export type PullResult = { mode: 'oldest' | 'newest'; calls: number; frames: number; msPerCall: number; msPerAudioS: number; dropped: number; expectedFrames: number };

/** Polls read() at `hz` for `seconds` (foreground only: JS timers). */
export async function runPull(mic: SelftestMic, mode: 'oldest' | 'newest', maxFrames: number, hz: number, seconds: number): Promise<PullResult> {
  await mic.setSyntheticSource?.({ kind: 'sine', hz: 440, rmsDbfs: -30 });
  const start = await mic.start({ source: 'auto', bufferMs: 100, ringSeconds: 10 });
  const t0 = Date.now();
  let calls = 0;
  let frames = 0;
  let dropped = 0;
  let ms = 0;
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      const a = now();
      const c = mic.read(maxFrames, mode);
      ms += now() - a;
      calls++;
      frames += c.data.length;
      dropped += c.dropped;
      if (Date.now() - t0 >= seconds * 1000) {
        clearInterval(id);
        resolve();
      }
    }, 1000 / hz);
  });
  const elapsed = (Date.now() - t0) / 1000;
  await mic.stop();
  await mic.setSyntheticSource?.(null);
  return { mode, calls, frames, msPerCall: ms / Math.max(1, calls), msPerAudioS: ms / Math.max(1e-9, frames / start.sampleRate), dropped, expectedFrames: Math.round(elapsed * start.sampleRate) };
}

// ---------------------------------------------------------------- A9 coverage
export type Coverage = { expectedS: number; storedS: number; pct: number; gapS: number };

/** Seconds stored vs expected over [startMs, endMs) (whole seconds of the session grid; first/last partial ones count). */
export function coverage(records: readonly { tMs: number }[], gaps: readonly Gap[], startMs: number, endMs: number): Coverage {
  const expectedS = Math.ceil((endMs - startMs) / 1000);
  const seen = new Set(records.map((r) => Math.round((r.tMs - startMs) / 1000)));
  let storedS = 0;
  for (let k = 0; k < expectedS; k++) if (seen.has(k)) storedS++;
  const gapS = gaps.reduce((s, g) => s + (g.endMs - g.startMs) / 1000, 0);
  return { expectedS, storedS, pct: (storedS / Math.max(1, expectedS)) * 100, gapS };
}
