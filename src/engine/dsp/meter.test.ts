/**
 * @jest-environment node
 */
import { DEFAULT_OFFSET_DB } from '../calibration';
import { chunks, clipped, multitone, pinkTones, seededRandom, sine, sineAmplitudeForRmsDbfs, toPcm16, toneBurst } from '../signals';
import { FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL, createMeter, type SecondRecord } from './meter';

const FS = 48000;

function run(pcm: Float32Array, fs = FS, offsetDb = 0, bufferSize = 4800): SecondRecord[] {
  const meter = createMeter({ fs, offsetDb });
  let t = 1_700_000_000_000;
  for (const c of chunks(pcm, bufferSize)) {
    meter.process(c, t);
    t += (c.length * 1000) / fs;
  }
  meter.flush();
  return meter.drainSeconds();
}

describe('E1 published calibration tone (Android CDD 5.11)', () => {
  it.each([48000, 44100])('1 kHz at RMS 520/32768 with the default offset reads LZ = LA = LC = 94.0 (fs %i)', (fs) => {
    const amp = Math.SQRT2 * (520 / 32768);
    expect(amp).toBeCloseTo(0.022442, 6);
    expect(DEFAULT_OFFSET_DB).toBeCloseTo(129.989, 3);
    // LAS needs ~5 s to settle (Slow, τ = 1 s): check seconds 5–6.
    const recs = run(sine(fs, 1000, amp, 7), fs, DEFAULT_OFFSET_DB).slice(5, 7);
    for (const r of recs) {
      expect(Math.abs(r.lzeq - 94)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.laeq - 94)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.lceq - 94)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.lafmax - 94)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.las - 94)).toBeLessThanOrEqual(0.05);
      // peak of a sine = RMS + 3.01 dB
      expect(Math.abs(r.lcpeak - 97.01)).toBeLessThanOrEqual(0.05);
      expect(r.flags).toBe(0);
    }
  });
});

describe('E4 / A3 tone bursts (IEC 61672-1:2002 Table 3 = 2013 Table 4 reference values)', () => {
  // [time weighting, Tb ms, IEC reference value]
  const IEC: [('F' | 'S'), number, number][] = [
    ['F', 1000, 0.0], ['F', 500, -0.1], ['F', 200, -1.0], ['F', 100, -2.6], ['F', 50, -4.8], ['F', 20, -8.3],
    ['F', 10, -11.1], ['F', 5, -14.1], ['F', 2, -18.0], ['F', 1, -21.0], ['F', 0.5, -24.0], ['F', 0.25, -27.0],
    ['S', 1000, -2.0], ['S', 500, -4.1], ['S', 200, -7.4], ['S', 100, -10.2], ['S', 50, -13.1], ['S', 20, -17.0],
    ['S', 10, -20.0], ['S', 5, -23.0], ['S', 2, -27.0],
  ];
  const amp = 0.1;
  const steady = (() => {
    const r = run(sine(FS, 4000, amp, 3)).slice(1, 3);
    return r[0].laeq;
  })();

  function burstResponse(tw: 'F' | 'S', tbMs: number, fs = FS) {
    const { pcm, burstS } = toneBurst(fs, 4000, amp, tbMs, 0.6, tw === 'F' ? 1.5 : 6);
    let maxLevel: number;
    if (tw === 'F') {
      maxLevel = Math.max(...run(pcm, fs).filter((r) => Number.isFinite(r.lafmax)).map((r) => r.lafmax));
    } else {
      // LASmax = max of the Slow detector; the meter exposes LAS at the end of each second, so sample it per ms.
      const meter = createMeter({ fs, offsetDb: 0 });
      maxLevel = -Infinity;
      let t = 0;
      for (const c of chunks(pcm, fs / 1000)) {
        meter.process(c, t);
        t += 1;
        maxLevel = Math.max(maxLevel, meter.live().las);
      }
    }
    const steadyFs = fs === FS ? steady : run(sine(fs, 4000, amp, 3), fs).slice(1, 3)[0].laeq;
    return { response: maxLevel - steadyFs, analytic: 10 * Math.log10(1 - Math.exp(-burstS / (tw === 'F' ? 0.125 : 1))) };
  }

  it.each(IEC)('%s %p ms: within ±0.3 dB of the IEC value %p; within ±0.1 dB of 10·lg(1 − e^(−Tb/τ)) for Tb ≥ 1 ms', (tw, tbMs, iec) => {
    const { response, analytic } = burstResponse(tw, tbMs);
    expect(Math.abs(response - iec)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(response - analytic)).toBeLessThanOrEqual(tbMs >= 1 ? 0.1 : 0.15);
  });

  it('1- and 2-cycle bursts (0.25/0.5 ms) deviate 0.11–0.14 dB from Eq. 15 at 48 kHz AND at 384 kHz: A-weighting physics, not digitisation (D25)', () => {
    for (const tb of [0.25, 0.5]) {
      const at48 = burstResponse('F', tb);
      const at384 = burstResponse('F', tb, 384000);
      expect(Math.abs(at48.response - at384.response)).toBeLessThan(0.02);
      expect(Math.abs(at48.response - at48.analytic)).toBeGreaterThan(0.08);
    }
  });

  it('E4 named cases: F200 −1.0, F2 −18.0, S200 −7.4, S2 −27.0, F50 −4.8 (analytic −0.98/−17.99/−7.42/−26.99)', () => {
    const analytic = (tb: number, tau: number) => 10 * Math.log10(1 - Math.exp(-tb / tau));
    expect(analytic(0.2, 0.125)).toBeCloseTo(-0.98, 2);
    expect(analytic(0.002, 0.125)).toBeCloseTo(-17.99, 2);
    expect(analytic(0.2, 1)).toBeCloseTo(-7.42, 2);
    expect(analytic(0.002, 1)).toBeCloseTo(-26.99, 2);
    expect(analytic(0.05, 0.125)).toBeCloseTo(-4.8, 1);
  });
});

describe('A4 overload detection', () => {
  it('0 false positives on unclipped −0.1 dBFS sines (Float32 and PCM16, 50 Hz–10 kHz)', () => {
    const peak = 10 ** (-0.1 / 20);
    for (const f of [50, 100, 997, 1000, 3150, 10000]) {
      for (const pcm of [sine(FS, f, peak, 2), toPcm16(sine(FS, f, peak, 2))]) {
        expect([f, run(pcm).filter((r) => r.flags & FLAG_OVERLOAD).length]).toEqual([f, 0]);
      }
    }
  });

  it('100 % of seconds flagged for hard-clipped sines (100 Hz–8 kHz, 1.2–3× full scale)', () => {
    for (const f of [100, 1000, 4000, 8000])
      for (const over of [1.2, 2, 3]) {
        const recs = run(clipped(sine(FS, f, over, 3), 1));
        expect([f, over, recs.every((r) => r.flags & FLAG_OVERLOAD)]).toEqual([f, over, true]);
      }
  });

  it('D29 (d): flags a flat top at the input maximum (≥ 3 equal samples ≥ 0.99) and live().overload', () => {
    const recs = run(clipped(sine(FS, 1000, 1.5, 2), 0.995));
    expect(recs.every((r) => r.flags & FLAG_OVERLOAD)).toBe(true);
    const three = new Float32Array(FS);
    three.set([0.995, 0.995, 0.995], 1000);
    expect(run(three)[0].flags & FLAG_OVERLOAD).toBeTruthy();
    three.fill(0).set([0.995, 0.995], 1000);
    expect(run(three)[0].flags & FLAG_OVERLOAD).toBe(0);
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    meter.process(clipped(sine(FS, 500, 2, 0.2), 0.995), 0);
    expect(meter.live().overload).toBe(true);
    meter.process(sine(FS, 500, 0.3, 1.1), 200);
    expect(meter.live().overload).toBe(false);
  });

  it('D29 (d): a 16-bit 20 Hz sine at −1 dBFS and at −0.1 dBFS is NOT flagged (blind set 1 S40); a limiter at 0.7 no longer is', () => {
    for (const dbfs of [-1, -0.1]) {
      const pcm = toPcm16(sine(FS, 20, 10 ** (dbfs / 20), 3));
      expect([dbfs, run(pcm).filter((r) => r.flags & FLAG_OVERLOAD).length]).toEqual([dbfs, 0]);
    }
    expect(run(clipped(sine(FS, 1000, 1.5, 2), 0.7)).filter((r) => r.flags & FLAG_OVERLOAD)).toHaveLength(0);
  });

  it('does not flag runs of equal samples below 0.99 or short equal pairs', () => {
    const pcm = new Float32Array(FS).fill(0.98);
    expect(run(pcm)[0].flags & FLAG_OVERLOAD).toBe(0);
    const pairs = new Float32Array(FS);
    for (let i = 0; i < FS; i++) pairs[i] = (i >> 1) % 2 ? 0.995 : -0.995; // runs of 2
    expect(run(pairs)[0].flags & FLAG_OVERLOAD).toBe(0);
  });
});

describe('records, flags and invariance', () => {
  it('buffer-boundary invariance: 1 × 48000·3 vs 480 × 100 vs random sizes give identical records', () => {
    const pcm = multitone(FS, pinkTones(-25, 7), 3);
    const whole = run(pcm, FS, 0, pcm.length);
    const small = run(pcm, FS, 0, 100);
    expect(small).toEqual(whole);
    const rnd = seededRandom(9);
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    let i = 0;
    while (i < pcm.length) {
      const n = 1 + Math.floor(rnd() * 3000);
      meter.process(pcm.subarray(i, i + n), 1_700_000_000_000 + (i * 1000) / FS);
      i += n;
    }
    meter.flush();
    expect(meter.drainSeconds()).toEqual(whole);
  });

  it('a whole second of exact zeros is mic-busy with no levels; a short buffer at the end is partial', () => {
    const pcm = new Float32Array(FS * 2.5);
    pcm.set(sine(FS, 1000, 0.1, 1), 0);
    const recs = run(pcm);
    expect(recs).toHaveLength(3);
    expect(recs[0].flags).toBe(0);
    expect(recs[1].flags & FLAG_MIC_BUSY).toBeTruthy();
    expect(Number.isNaN(recs[1].laeq)).toBe(true);
    expect(recs[2].flags & FLAG_PARTIAL).toBeTruthy();
  });

  it('a forward timestamp jump (dropped frames) skips the missing seconds and marks partial ones', () => {
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    const t0 = 1_000_000;
    meter.process(sine(FS, 1000, 0.1, 1.5), t0);
    meter.process(sine(FS, 1000, 0.1, 1.5), t0 + 4000); // 2.5 s missing
    meter.flush();
    const recs = meter.drainSeconds();
    expect(recs.map((r) => r.tMs - t0)).toEqual([0, 1000, 4000, 5000]);
    expect(recs[1].flags & FLAG_PARTIAL).toBeTruthy();
    expect(recs[3].flags & FLAG_PARTIAL).toBeTruthy();
    expect(recs[2].flags).toBe(0);
  });

  it('review M2: after a hole the meter restarts — no level from before the hole leaks into the next seconds', () => {
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    const t0 = 1_000_000;
    meter.process(sine(FS, 1000, sineAmplitudeForRmsDbfs(-20), 3), t0); // 3 s at −20 dBFS ("80 dB")
    const quiet = sineAmplitudeForRmsDbfs(-70); // "30 dB"
    meter.process(sine(FS, 1000, quiet, 3), t0 + 13_000); // 10-s hole (frames lost, or pause → resume)
    meter.flush();
    const recs = meter.drainSeconds();
    const first = recs.find((r) => r.tMs === t0 + 13_000)!;
    expect(first.lafmax).toBeLessThanOrEqual(-70 + 0.5); // was −20.0 (80 dB) before the fix
    expect(Math.abs(first.laeq - -70)).toBeLessThan(0.05); // was −58.8 (41.2 dB)
    expect(first.las).toBeLessThan(-70 + 0.1); // LAS rises from rest as at the start (−2 dB low), never from 80 dB
    expect(Math.abs(recs.find((r) => r.tMs === t0 + 14_000)!.lafmin - -70)).toBeLessThan(0.1);
  });

  it('a hole inside a second: LAFmin settles again; the second is partial', () => {
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    const loud = sineAmplitudeForRmsDbfs(-20);
    meter.process(sine(FS, 1000, loud, 1.2), 0);
    meter.process(sine(FS, 1000, loud, 1.8), 1_600); // 400 ms missing inside second 1
    meter.flush();
    const [, second] = meter.drainSeconds();
    expect(second.flags & FLAG_PARTIAL).toBeTruthy();
    expect(Math.abs(second.lafmin - -20)).toBeLessThan(0.2); // without the settle it would read the restart's rise
  });

  it('continuous = true re-aligns the grid for clock drift without a restart (capture.ts drift correction)', () => {
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    const a = sineAmplitudeForRmsDbfs(-30);
    let t = 0;
    for (const c of chunks(sine(FS, 1000, a, 4), 4800)) {
      meter.process(c, t > 2000 ? t + 80 : t, true); // the clock runs 80 ms ahead from 2 s on
      t += 100;
    }
    meter.flush();
    const recs = meter.drainSeconds();
    expect(recs.map((r) => r.tMs)).toEqual([0, 1000, 2000, 3000, 4000]);
    for (const r of recs.slice(0, 4)) expect(Math.abs(r.laeq - -30)).toBeLessThan(0.05);
    expect(recs[2].flags & FLAG_PARTIAL).toBe(0); // 0.92 s of samples: not partial
    // no restart: Slow continues exactly as without drift (a restart would read ≈ −2 dB)
    const plain = run(sine(FS, 1000, a, 4));
    expect(Math.abs(recs[3].las - plain[3].las)).toBeLessThan(0.01);
  });

  it('review S7: the meter refuses sample rates below 44.1 kHz', () => {
    expect(() => createMeter({ fs: 16000, offsetDb: 0 })).toThrow('44100');
    expect(() => createMeter({ fs: 8000, offsetDb: 0 })).toThrow();
    expect(() => createMeter({ fs: 44100, offsetDb: 0 })).not.toThrow();
  });

  it('review S6: a DC offset does not reach LZeq (30 dB tone + DC 0.001 FS → LZeq 30.0, LA/LC unchanged)', () => {
    const tone = sine(FS, 1000, sineAmplitudeForRmsDbfs(30 - DEFAULT_OFFSET_DB), 4);
    const withDc = tone.map((x) => x + 0.001);
    const recs = run(Float32Array.from(withDc), FS, DEFAULT_OFFSET_DB);
    for (const r of recs.slice(1)) {
      expect(Math.abs(r.lzeq - 30)).toBeLessThan(0.05); // was 70.0 before the fix
      expect(Math.abs(r.laeq - 30)).toBeLessThan(0.05);
      expect(Math.abs(r.lceq - 30)).toBeLessThan(0.05);
    }
  });

  it('small timestamp jitter (< 50 ms) does not move the grid', () => {
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    let t = 0;
    for (const c of chunks(sine(FS, 1000, 0.1, 3), 4800)) {
      meter.process(c, t + (Math.round(t / 100) % 3) * 7); // ±7..14 ms jitter
      t += 100;
    }
    expect(meter.drainSeconds().map((r) => [r.tMs, r.flags])).toEqual([
      [0, 0],
      [1000, 0],
      [2000, 0],
    ]);
  });

  it('Fast vs Slow: a step from 40 to 80 dB reaches LAF ≈ 80 within 1 s, LAS lags; LAFmin ignores the start-up', () => {
    const pcm = new Float32Array(FS * 4);
    pcm.set(sine(FS, 1000, sineAmplitudeForRmsDbfs(-80), 2), 0);
    pcm.set(sine(FS, 1000, sineAmplitudeForRmsDbfs(-40), 2), FS * 2);
    const recs = run(pcm, FS, 120);
    expect(Math.abs(recs[0].lafmin - 40)).toBeLessThan(0.2);
    expect(Math.abs(recs[2].lafmax - 80)).toBeLessThan(0.1);
    expect(recs[2].las).toBeLessThan(80 - 0.0); // Slow at the end of the first loud second: 80 + 10lg(1 − e^−1) ≈ 78.0
    expect(Math.abs(recs[2].las - (80 + 10 * Math.log10(1 - Math.exp(-1))))).toBeLessThan(0.15);
  });

  it('setOffset shifts live values and later records', () => {
    const meter = createMeter({ fs: FS, offsetDb: 100 });
    meter.process(sine(FS, 1000, 0.1, 1), 0);
    const before = meter.live().laf;
    meter.setOffset(104.3);
    expect(meter.live().laf - before).toBeCloseTo(4.3, 9);
  });

  it('performance: 60 s of 48 kHz audio in well under 20 ms per second of audio (Node)', () => {
    const pcm = multitone(FS, pinkTones(-30, 3, 13, 20), 60);
    const meter = createMeter({ fs: FS, offsetDb: 0 });
    const start = performance.now();
    let t = 0;
    for (const c of chunks(pcm, 4800)) {
      meter.process(c, t);
      t += 100;
    }
    const msPerSecond = (performance.now() - start) / 60;
    if (process.env.PRINT_TABLES) console.log(`meter: ${msPerSecond.toFixed(2)} ms per second of audio`);
    expect(meter.drainSeconds()).toHaveLength(60);
    expect(msPerSecond).toBeLessThan(20);
  });
});
