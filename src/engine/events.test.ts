/**
 * @jest-environment node
 */
import { FLAG_MIC_BUSY } from './dsp/meter';
import { detectEvents, eventMetrics, flattenCandidates, isLabelled, markEvent, nestedPeaks, planRedetect, type StoredEventRef } from './events';
import { recordsFromScript, seededRandom, type ScriptSegment } from './signals';

const T0 = Date.UTC(2026, 9, 16, 21, 0, 0);

describe('E6 and detection rules', () => {
  it('E6: background 30 for 15 min; 60 s at 50, 5 s at 30, 10 s at 50 → one event of 75 s, LAeq 49.70, LAFmax 50.0', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 60, db: 50 },
      { seconds: 5, db: 30 },
      { seconds: 10, db: 50 },
      { seconds: 300, db: 30 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev).toHaveLength(1);
    expect(ev[0].startMs - T0).toBe(900_000);
    expect(ev[0].endMs - ev[0].startMs).toBe(75_000);
    expect(ev[0].laeq.toFixed(2)).toBe('49.70');
    expect(ev[0].lafmax).toBe(50);
    expect(ev[0].backgroundDb).toBe(30);
  });

  it('11 quiet seconds split two events; sensitivity changes what counts as loud', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 20, db: 38 },
      { seconds: 11, db: 30 },
      { seconds: 20, db: 38 },
      { seconds: 300, db: 30 },
    ]);
    expect(detectEvents(recs, [], { sensitivity: 'high' })).toHaveLength(2);
    expect(detectEvents(recs, [], { sensitivity: 'normal' })).toHaveLength(0); // 38 < 30 + 10
  });

  it('absolute floor 35 dB(A): +10 dB above a 20-dB room is not an event', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 20 },
      { seconds: 30, db: 34.9 },
      { seconds: 300, db: 20 },
    ]);
    expect(detectEvents(recs, [], { sensitivity: 'normal' })).toHaveLength(0);
  });

  it('warming up: no event before 60 valid seconds; first/last 10 s never start one', () => {
    const early = recordsFromScript(T0, [
      { seconds: 59, db: 30 },
      { seconds: 30, db: 60 },
      { seconds: 300, db: 30 },
    ]);
    // the loud second at 59 s falls into the warm-up (59 valid values); from 60 s on the background exists
    expect(detectEvents(early, [], { sensitivity: 'normal' }).map((e) => (e.startMs - T0) / 1000)).toEqual([60]);
    const late = recordsFromScript(T0, [
      { seconds: 600, db: 30 },
      { seconds: 9, db: 60 },
    ]);
    expect(detectEvents(late, [], { sensitivity: 'normal' })).toHaveLength(0);
  });

  it('a gap or a missing second ends an event; mic-busy seconds count as missing', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 30, db: 60 },
      { seconds: 20, db: null },
      { seconds: 30, db: 60 },
      { seconds: 300, db: 30 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev.map((e) => [(e.startMs - T0) / 1000, (e.endMs - e.startMs) / 1000])).toEqual([
      [900, 30],
      [950, 30],
    ]);
    const gapped = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 60, db: 60 },
      { seconds: 300, db: 30 },
    ]);
    const gaps = [{ startMs: T0 + 930_000, endMs: T0 + 935_000, reason: 'interruption' as const }];
    expect(detectEvents(gapped, gaps, { sensitivity: 'normal' })).toHaveLength(2);
    const busy = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 30, db: 60 },
      { seconds: 3, db: 0, flags: FLAG_MIC_BUSY },
      { seconds: 30, db: 60 },
      { seconds: 300, db: 30 },
    ]);
    busy.filter((r) => r.flags).forEach((r) => (r.laeq = NaN));
    expect(detectEvents(busy, [], { sensitivity: 'normal' })).toHaveLength(2);
  });

  it('a long event keeps its start background; the room background is restored afterwards', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 1800, db: 55 },
      { seconds: 900, db: 30 },
      { seconds: 20, db: 45 },
      { seconds: 300, db: 30 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev.map((e) => (e.endMs - e.startMs) / 1000)).toEqual([1800, 20]);
    expect(ev[1].backgroundDb).toBe(30);
  });

  it('review S5: a session start off the records\' 1-s grid (400 ms) still finds E6 — not 0 events', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 60, db: 50 },
      { seconds: 5, db: 30 },
      { seconds: 10, db: 50 },
      { seconds: 300, db: 30 },
    ]);
    for (const off of [-400, 400, 1]) {
      const ev = detectEvents(recs, [], { sensitivity: 'normal', sessionStartMs: T0 + off, sessionEndMs: T0 + 1_275_000 + off });
      expect([off, ev.map((e) => [(e.startMs - T0) / 1000, (e.endMs - e.startMs) / 1000])]).toEqual([off, [[900, 75]]]);
    }
  });

  it('D29 (a): B holds while an event is open — a 20-min rumble is ONE long event, never cut by the window', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 28 },
      { seconds: 1200, db: 40 }, // +12: N07-like; the literal reading cut it after 541 s
      { seconds: 900, db: 28 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev.map((e) => [(e.startMs - T0) / 1000, (e.endMs - T0) / 1000, e.long, e.backgroundDb])).toEqual([[900, 2100, true, 28]]);
  });

  it('D29 (a): after a long event the last B is held — an event right after it is found (no second warm-up)', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 1800, db: 55 },
      { seconds: 15, db: 30 },
      { seconds: 5, db: 45 }, // window holds only 15 values here: B held at 30
      { seconds: 300, db: 30 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev.map((e) => [(e.startMs - T0) / 1000, (e.endMs - e.startMs) / 1000, e.backgroundDb])).toEqual([
      [900, 1800, 30],
      [2715, 5, 30],
    ]);
  });

  it('D29 (a)/S1: a 3-h fan with a door slam under it → one long event with the slam as a nested peak', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 5400, db: 42 },
      { seconds: 3, db: 44, lafmax: 62 },
      { seconds: 5400, db: 42 },
      { seconds: 600, db: 30 },
    ]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ long: true, startMs: T0 + 900_000, endMs: T0 + 11_703_000 });
    expect(ev[0].peaks.map((p) => [(p.startMs - T0) / 1000, (p.endMs - T0) / 1000, p.lafmax, p.backgroundDb, p.long])).toEqual([[6300, 6303, 62, 42, false]]);
    // a sub-peak only 9.9 dB above the running level is not one; a short event never gets peaks
    const weak = recs.map((r) => (r.lafmax === 62 ? { ...r, lafmax: 51.9 } : r));
    expect(detectEvents(weak, [], { sensitivity: 'normal' })[0].peaks).toEqual([]);
    const short = recordsFromScript(T0, [{ seconds: 900, db: 30 }, { seconds: 300, db: 42 }, { seconds: 3, db: 42, lafmax: 62 }, { seconds: 296, db: 42 }, { seconds: 600, db: 30 }]);
    expect(detectEvents(short, [], { sensitivity: 'normal' }).map((e) => [e.long, e.peaks.length, (e.endMs - e.startMs) / 1000])).toEqual([[false, 0, 599]]);
    // stored flat (finalise), the peak is recognised by containment and not counted as an event of its own
    const flat = flattenCandidates(ev).map((e, i) => ({ ...e, id: i + 1, source: 'auto' }));
    expect(flat.map((e) => e.id)).toEqual([1, 2]);
    expect([...nestedPeaks(flat).entries()].map(([c, p]) => [c, p.id])).toEqual([[2, 1]]);
  });

  it('D29 (b): quiet seconds inside a merged event count as inside it — they never raise B after the event', () => {
    // a 12-min knock chain (knock 50, then 9 s at 38); then a 44-dB bang 20 s later. With the quiet 38s in the window
    // (the "loud only" reading) B would be 38 and the bang (needs 48) missed; inside the event, B holds 30 → found.
    const chain: ScriptSegment[] = [];
    for (let k = 0; k < 72; k++) chain.push({ seconds: 1, db: 50 }, { seconds: 9, db: 38 });
    const recs = recordsFromScript(T0, [{ seconds: 900, db: 30 }, ...chain, { seconds: 20, db: 30 }, { seconds: 3, db: 44 }, { seconds: 300, db: 30 }]);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev.map((e) => [(e.startMs - T0) / 1000, (e.endMs - T0) / 1000])).toEqual([
      [900, 900 + 711],
      [900 + 720 + 20, 900 + 720 + 23],
    ]);
  });

  it('D29 (c): the 600-s window excludes the current second (warm-up edge: 59 earlier values are not enough)', () => {
    const at = (loudAt: number) =>
      detectEvents(recordsFromScript(T0, [{ seconds: loudAt, db: 30 }, { seconds: 1, db: 45 }, { seconds: 300, db: 30 }]), [], { sensitivity: 'normal' }).map(
        (e) => (e.startMs - T0) / 1000
      );
    expect(at(59)).toEqual([]); // [t−600, t−1] holds 59 values: still warming up (incl. the current second it would be 60)
    expect(at(60)).toEqual([60]);
  });

  it('uses LAFmax for loudness and reports the LF hint and metrics', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 5, db: 36, lafmax: 48, lc: 52 },
      { seconds: 300, db: 30 },
    ]);
    const [e] = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(e.lafmax).toBe(48);
    expect(e.lfHint).toBe(true);
    expect(e.lceq).toBe(52);
    expect(eventMetrics(recs, e.startMs, e.endMs).laeq).toBe(36);
  });

  it('is deterministic and handles an empty or unsorted series', () => {
    expect(detectEvents([], [], { sensitivity: 'normal' })).toEqual([]);
    const recs = recordsFromScript(T0, [
      { seconds: 900, db: 30 },
      { seconds: 30, db: 60 },
      { seconds: 300, db: 30 },
    ]);
    const shuffled = [...recs].reverse();
    expect(detectEvents(shuffled, [], { sensitivity: 'normal' })).toEqual(detectEvents(recs, [], { sensitivity: 'normal' }));
  });
});

describe('A5: 20 synthetic nights (own generator; the blind set comes from P2.5)', () => {
  // Night = background with ±1 dB noise; 3–8 disturbances of 5–300 s at +12…+30 dB, separated by ≥ 60 s; in 5 nights
  // a gap in the middle of the night (no records). Truth = the script; the detector must find each one, start/end ±1 s.
  function night(seed: number) {
    const rnd = seededRandom(seed);
    const bg = 25 + rnd() * 15;
    const segs: ScriptSegment[] = [];
    const truth: { start: number; end: number }[] = [];
    let t = 0;
    const quiet = (s: number) => {
      for (let i = 0; i < s; i++) segs.push({ seconds: 1, db: Math.round((bg + (rnd() * 2 - 1)) * 10) / 10 });
      t += s;
    };
    quiet(900 + Math.floor(rnd() * 600));
    const n = 3 + Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      const dur = 5 + Math.floor(rnd() * 296);
      const level = bg + 12 + rnd() * 18;
      truth.push({ start: t, end: t + dur });
      segs.push({ seconds: dur, db: level, lafmax: level + 2 });
      t += dur;
      if (seed % 4 === 0 && k === 1) {
        quiet(120);
        segs.push({ seconds: 300, db: null });
        t += 300;
        quiet(700); // background window refills after the gap
      } else quiet(60 + Math.floor(rnd() * 900));
    }
    quiet(600);
    return { recs: recordsFromScript(T0, segs), truth };
  }

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))('night %i: count exact, start/end within ±1 s', (seed) => {
    const { recs, truth } = night(seed);
    const ev = detectEvents(recs, [], { sensitivity: 'normal' });
    expect(ev).toHaveLength(truth.length);
    ev.forEach((e, i) => {
      expect(Math.abs((e.startMs - T0) / 1000 - truth[i].start)).toBeLessThanOrEqual(1);
      expect(Math.abs((e.endMs - T0) / 1000 - truth[i].end)).toBeLessThanOrEqual(1);
    });
  });

  it('24-hour series runs fast enough for the phone (Node: < 1 s)', () => {
    const recs = recordsFromScript(T0, [{ seconds: 86400, db: 30 }]);
    const start = performance.now();
    detectEvents(recs, [], { sensitivity: 'normal' });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('marks and re-detect', () => {
  it('a mark covers t ± 30 s clipped to the session', () => {
    const recs = recordsFromScript(T0, [{ seconds: 120, db: 40 }]);
    const m = markEvent(recs, T0 + 10_000, T0, T0 + 120_000);
    expect([m.startMs - T0, m.endMs - T0]).toEqual([0, 40_000]);
    expect(m.laeq).toBe(40);
  });

  it('re-detect drops unlabelled autos, keeps labelled ones as marks, never duplicates kept intervals', () => {
    const base = { categoryOther: '', note: '', witnesses: '', effect: null, excluded: false };
    const existing: StoredEventRef[] = [
      { id: 1, source: 'auto', startMs: 0, endMs: 10, category: null, ...base },
      { id: 2, source: 'auto', startMs: 20, endMs: 30, category: 'music', ...base },
      { id: 3, source: 'mark', startMs: 40, endMs: 50, category: null, ...base },
      { id: 4, source: 'manual', startMs: 60, endMs: 70, category: 'voices', ...base },
    ];
    const cand = (s: number, e: number) => ({ startMs: s, endMs: e, backgroundDb: 30, laeq: 50, lafmax: 50, lcpeak: 60, lceq: 50, lfHint: false, overloadS: 0, long: false, peaks: [] });
    const plan = planRedetect(existing, [cand(0, 12), cand(25, 35), cand(80, 90)]);
    expect(plan.removeIds).toEqual([1]);
    expect(plan.convertToMarkIds).toEqual([2]);
    expect(plan.insert.map((c) => c.startMs)).toEqual([0, 80]);
    expect(isLabelled({ ...base, category: null, excluded: true })).toBe(true);
  });
});
