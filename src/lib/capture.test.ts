/**
 * @jest-environment node
 */
// End to end in Node: fake microphone → capture pipeline → minute blocks + gaps in SQLite → finalise → events.
// Proves the module interface (modules/mic-pcm) and the engine fit together before the native module exists (P3).
import { createFakeMic } from '../../modules/mic-pcm/src/fake';
import { createTestDb } from '../../test/node-sqlite-db';
import { newSession } from '../../test/fixtures';
import { readRecords, upsertBlock } from '@/db/blocks';
import { listSessionEvents } from '@/db/events';
import { addGap, listGaps } from '@/db/gaps';
import { migrate } from '@/db/migrations';
import { createSession, finaliseSession, getSession } from '@/db/sessions';
import { DEFAULT_OFFSET_DB } from '@/engine/calibration';
import type { EncodedBlock } from '@/engine/codec';
import type { SecondRecord } from '@/engine/dsp/meter';
import { aggregate, type Gap } from '@/engine/levels';
import { sineAmplitudeForRmsDbfs } from '@/engine/signals';

import { createCapturePipeline } from './capture';

const FS = 48000;
const START = Date.UTC(2026, 9, 24, 20, 0, 0);

/** A scripted night at the PCM level: 1 kHz tone at the given dB SPL estimate (default offset) per time range. */
function scriptGenerator(script: { untilS: number; db: number }[]) {
  const period = new Float64Array(48); // 1 kHz at 48 kHz = exactly 48 samples per cycle
  for (let i = 0; i < 48; i++) period[i] = Math.sin((2 * Math.PI * i) / 48);
  return (framePos: number, frames: number, fs: number) => {
    const out = new Float32Array(frames);
    let seg = 0;
    for (let i = 0; i < frames; i++) {
      const t = (framePos + i) / fs;
      while (seg < script.length - 1 && t >= script[seg].untilS) seg++;
      out[i] = sineAmplitudeForRmsDbfs(script[seg].db - DEFAULT_OFFSET_DB) * period[(framePos + i) % 48];
    }
    return out;
  };
}

describe('capture pipeline with the fake microphone (A8 maths in Node, A9 shape)', () => {
  it('E1 through the pipeline: RMS 520/32768 at 1 kHz reads 94.0 ± 0.05 with the default offset', async () => {
    const mic = createFakeMic({ sampleRate: FS, startTimeMs: START, generator: scriptGenerator([{ untilS: 1e9, db: 94 }]) });
    const blocks: EncodedBlock[] = [];
    const pipe = createCapturePipeline({ sampleRate: FS, offsetDb: DEFAULT_OFFSET_DB, sessionStartMs: START, onBlock: (b) => blocks.push(b), onGap: () => {} });
    mic.addListener('buffer', (c) => pipe.push(c));
    await mic.start({ bufferMs: 100 });
    mic.pump(5);
    pipe.finish(START + 5000);
    expect(Math.abs(pipe.live().laf - 94)).toBeLessThan(0.05);
    expect(blocks).toHaveLength(1);
  });

  it('a scripted night: blocks every minute, gaps for interruption / mic-busy / lost frames, events after finalise', async () => {
    const db = createTestDb();
    await migrate(db);
    const sid = await createSession(db, newSession({ startedAt: START }));
    const script = [
      { untilS: 120, db: 30 },
      { untilS: 180, db: 50 },
      { untilS: 185, db: 30 },
      { untilS: 195, db: 50 },
      { untilS: 1e9, db: 30 },
    ];
    const mic = createFakeMic({ sampleRate: FS, startTimeMs: START, generator: scriptGenerator(script) });
    const writes: Promise<void>[] = [];
    const gaps: Gap[] = [];
    const pipe = createCapturePipeline({
      sampleRate: FS,
      offsetDb: DEFAULT_OFFSET_DB,
      sessionStartMs: START,
      onBlock: (b) => writes.push(upsertBlock(db, sid, b)),
      onGap: (g) => {
        gaps.push(g);
        writes.push(addGap(db, sid, g).then(() => undefined));
      },
    });
    mic.addListener('buffer', (c) => pipe.push(c));
    await mic.start({ bufferMs: 100 });
    mic.pump(300);
    // a phone call: iOS-style interruption (no audio delivered meanwhile), then Android-style zeros, then lost frames
    pipe.event({ type: 'interruption-began', t: START + 300_000 });
    mic.drop(20 * FS); // the module delivers nothing for 20 s
    pipe.event({ type: 'interruption-ended', t: START + 320_000 });
    mic.pump(60);
    mic.zeros(5);
    mic.pump(65);
    mic.drop(3 * FS);
    mic.pump(100);
    const end = START + 548_000;
    pipe.finish(end);
    await Promise.all(writes);

    // review M1(b): the 20 s the interruption already explains are NOT a second, duplicate frames-lost gap
    expect(gaps.map((g) => [g.reason, (g.startMs - START) / 1000, (g.endMs - START) / 1000])).toEqual([
      ['interruption', 300, 320],
      ['mic-busy', 380, 385],
      ['frames-lost', 445, 448],
    ]);
    const recs = await readRecords(db, sid);
    expect(recs.length).toBe(548 - 20 - 3);
    await finaliseSession(db, sid, end);
    const ev = await listSessionEvents(db, sid);
    expect(ev).toHaveLength(1);
    expect((ev[0].startMs - START) / 1000).toBe(120);
    // 76, not E6's 75: at the PCM level the Fast detector still decays from 50 dB during the next second, so that
    // second's LAFmax is loud too (A5 allows ±1 s at the end).
    expect((ev[0].endMs - ev[0].startMs) / 1000).toBe(76);
    expect(Math.abs(ev[0].laeq! - 10 * Math.log10((70 * 1e5 + 6 * 1e3) / 76))).toBeLessThan(0.02); // 70 s at 50 + 6 s at 30
    const s = await getSession(db, sid);
    expect(s?.backgroundDb).toBeCloseTo(30, 1);
    expect((await listGaps(db, sid)).length).toBe(3);
  });

  it('pull mode (read oldest) gives the same records as push mode; newest mode serves the tuner', async () => {
    const gen = scriptGenerator([{ untilS: 1e9, db: 60 }]);
    const run = async (mode: 'push' | 'pull') => {
      const mic = createFakeMic({ sampleRate: FS, startTimeMs: START, generator: gen });
      const recs: number[] = [];
      const pipe = createCapturePipeline({ sampleRate: FS, offsetDb: DEFAULT_OFFSET_DB, sessionStartMs: START, onBlock: () => {}, onGap: () => {}, onRecords: (r) => recs.push(...r.map((x) => x.laeq)) });
      if (mode === 'push') mic.addListener('buffer', (c) => pipe.push(c));
      await mic.start({ bufferMs: 100, ringSeconds: 10 });
      for (let i = 0; i < 10; i++) {
        mic.pump(1);
        if (mode === 'pull') pipe.push(mic.read(FS, 'oldest'));
      }
      pipe.finish(START + 10_000);
      return recs;
    };
    expect(await run('pull')).toEqual(await run('push'));
    const mic = createFakeMic({ sampleRate: FS, startTimeMs: START, generator: gen });
    await mic.start({ bufferMs: 100 });
    mic.pump(1);
    const newest = mic.read(4096, 'newest');
    expect(newest.data.length).toBeGreaterThanOrEqual(4096);
    expect(newest.framePos + newest.data.length).toBe(FS);
  });
});

/** Runs a fake-mic scenario through the pipeline; returns records, gaps and the opened gaps. */
function harness(o: { startTimeMs?: number; sessionStartMs?: number; script: { untilS: number; db: number }[] }) {
  const sessionStartMs = o.sessionStartMs ?? START;
  const mic = createFakeMic({ sampleRate: FS, startTimeMs: o.startTimeMs ?? sessionStartMs, generator: scriptGenerator(o.script) });
  const records: SecondRecord[] = [];
  const gaps: Gap[] = [];
  const opened: { startMs: number; reason: string }[] = [];
  const pipe = createCapturePipeline({
    sampleRate: FS,
    offsetDb: DEFAULT_OFFSET_DB,
    sessionStartMs,
    onBlock: () => {},
    onGap: (g) => gaps.push(g),
    onGapOpen: (g) => opened.push(g),
    onRecords: (r) => records.push(...r),
  });
  mic.addListener('buffer', (c) => pipe.push(c));
  const rel = (t: number) => (t - sessionStartMs) / 1000;
  return { mic, pipe, records, gaps, opened, rel, at: (s: number) => sessionStartMs + s * 1000 };
}

describe('review M1: capture time comes from the monotonic clock, anchored once per frame burst', () => {
  const script = [
    { untilS: 30, db: 40 },
    { untilS: 1e9, db: 60 },
  ];
  for (const mode of ['continues', 'jumps', 'restarts'] as const) {
    it(`(a/b) interruption 30→90 s with framePos that ${mode}: 60-dB seconds at +90…+119, LAeq 57.03, one gap`, async () => {
      const h = harness({ script: [{ untilS: 90, db: 40 }, ...script.slice(1)] });
      await h.mic.start({ bufferMs: 100 });
      h.mic.pump(30);
      h.pipe.event({ type: 'interruption-began', t: h.at(30) });
      h.mic.stall(60, mode); // no frames for 60 s; AVAudioEngine restart style
      h.pipe.event({ type: 'interruption-ended', t: h.at(90) });
      h.mic.pump(30);
      h.pipe.finish(h.at(120));
      const loud = h.records.filter((r) => r.laeq > 55).map((r) => h.rel(r.tMs));
      expect(loud[0]).toBe(90);
      expect(loud[loud.length - 1]).toBe(119);
      expect(h.gaps.map((g) => [g.reason, h.rel(g.startMs), h.rel(g.endMs)])).toEqual([['interruption', 30, 90]]);
      const s = aggregate(h.records, h.gaps, { startMs: START, endMs: h.at(120) });
      expect(Math.abs(s.laeq - 10 * Math.log10((30 * 1e4 + 30 * 1e6) / 60))).toBeLessThan(0.05); // 57.03
      expect(s.validMs).toBe(60_000);
      expect(s.gapMs).toBe(60_000);
    });
  }

  it('(c) a backlog older than the session start: frames before the start are dropped, times exact', async () => {
    // the ring held 5 s before the log started (live meter running); a 70-dB second at wall +10 s
    const h = harness({ startTimeMs: START - 5000, script: [{ untilS: 15, db: 40 }, { untilS: 16, db: 70 }, { untilS: 1e9, db: 40 }] });
    await h.mic.start({ bufferMs: 100, ringSeconds: 10 });
    h.mic.pump(25);
    h.pipe.finish(h.at(20));
    expect(h.rel(h.records[0].tMs)).toBe(0);
    const loud = h.records.filter((r) => r.laeq > 60).map((r) => h.rel(r.tMs));
    expect(loud).toEqual([10]); // was +15: the whole night 5 s late
    expect(Math.abs(h.records.find((r) => h.rel(r.tMs) === 10)!.laeq - 70)).toBeLessThan(0.05);
    expect(h.gaps).toEqual([]);
  });

  it('a hole no event explains becomes exactly one frames-lost gap; the meter restarts after it (M2)', async () => {
    const h = harness({ script: [{ untilS: 20, db: 80 }, { untilS: 1e9, db: 30 }] });
    await h.mic.start({ bufferMs: 100 });
    h.mic.pump(20);
    h.mic.stall(10, 'continues'); // e.g. the OS froze the app and the native side lost the frames without saying so
    h.mic.pump(10);
    h.pipe.finish(h.at(40));
    expect(h.gaps.map((g) => [g.reason, h.rel(g.startMs), h.rel(g.endMs)])).toEqual([['frames-lost', 20, 30]]);
    const after = h.records.find((r) => h.rel(r.tMs) === 30)!;
    expect(after.lafmax).toBeLessThan(30.5); // no 80 dB carried over the hole
  });

  it('a pause during a mic-busy stretch is honoured through the pipeline (M3): nothing is measured while paused', async () => {
    const h = harness({ script: [{ untilS: 1e9, db: 45 }] });
    await h.mic.start({ bufferMs: 100 });
    h.mic.pump(60);
    h.mic.zeros(10); // mic taken at 60 s
    h.mic.pump(5);
    h.pipe.event({ type: 'pause', t: h.at(65) });
    h.mic.pump(15); // mic back at 70 s while paused
    h.pipe.event({ type: 'resume', t: h.at(80) });
    h.mic.pump(20);
    h.pipe.finish(h.at(100));
    expect(h.records.filter((r) => h.rel(r.tMs) > 65 && h.rel(r.tMs) < 80)).toEqual([]);
    // the mic-busy gap closes at the first measured second after the pause (nothing is measured while paused)
    expect(h.gaps.map((g) => [g.reason, h.rel(g.startMs), h.rel(g.endMs)])).toEqual([
      ['paused', 65, 80],
      ['mic-busy', 60, 80],
    ]);
    expect(h.pipe.state().phase).toBe('finished');
  });

  it('sample-clock drift (2000 ppm) stays bounded: times within 0.1 s of the monotonic clock, no gaps (N9)', () => {
    const records: SecondRecord[] = [];
    const gaps: Gap[] = [];
    const pipe = createCapturePipeline({ sampleRate: FS, offsetDb: DEFAULT_OFFSET_DB, sessionStartMs: START, onBlock: () => {}, onGap: (g) => gaps.push(g), onRecords: (r) => records.push(...r) });
    const gen = scriptGenerator([{ untilS: 1e9, db: 50 }]);
    const n = FS / 10;
    for (let k = 0; k < 3000; k++) {
      // 300 s; the device clock is 0.2 % slow: wall time runs ahead of framePos/fs by 0.6 s in the end
      pipe.push({ data: gen(k * n, n, FS), framePos: k * n, tMs: START + k * 100 * 1.002, dropped: 0, sampleRate: FS });
    }
    pipe.finish(START + 300_600);
    expect(gaps).toEqual([]);
    const ts = records.map((r) => (r.tMs - START) / 1000);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBeGreaterThanOrEqual(299);
    expect(records.filter((r) => Math.abs(r.laeq - 50) > 0.1)).toHaveLength(0);
  });
});

describe('review S4 / S7: open gaps are reported at once; a rate change rebuilds the meter', () => {
  it('onGapOpen fires when an interruption begins and onGap closes it', async () => {
    const h = harness({ script: [{ untilS: 1e9, db: 40 }] });
    await h.mic.start({ bufferMs: 100 });
    h.mic.pump(10);
    h.pipe.event({ type: 'interruption-began', t: h.at(10) });
    expect(h.opened).toEqual([{ startMs: h.at(10), reason: 'interruption' }]);
    expect(h.gaps).toEqual([]);
    h.pipe.event({ type: 'interruption-ended', t: h.at(12) });
    expect(h.gaps).toEqual([{ startMs: h.at(10), endMs: h.at(12), reason: 'interruption' }]);
  });

  it('16 kHz (Bluetooth HFP) is refused as a route-change gap; back at 48 kHz the levels are right again', async () => {
    const h = harness({ script: [{ untilS: 1e9, db: 50 }] });
    await h.mic.start({ bufferMs: 100 });
    h.mic.pump(20);
    h.mic.setRate(16000);
    h.mic.pump(10);
    h.mic.setRate(48000);
    h.mic.pump(20);
    h.pipe.finish(h.at(50));
    expect(h.gaps.map((g) => [g.reason, h.rel(g.startMs), h.rel(g.endMs)])).toEqual([['route-change', 20, 30]]);
    const after = h.records.filter((r) => h.rel(r.tMs) >= 31);
    expect(after.length).toBeGreaterThanOrEqual(18);
    for (const r of after) expect(Math.abs(r.laeq - 50)).toBeLessThan(0.05);
  });
});

