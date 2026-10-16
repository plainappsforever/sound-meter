import type { SecondRecord } from './dsp/meter';

// Synthetic test signals (shared by Jest tests, the test-signal script spec and the dev synthetic source, D24).
// All PCM is mono Float32 in [−1, 1] like the capture module delivers. Deterministic: random parts take a seed.

/** Mulberry32: small seeded PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Peak amplitude of a sine whose RMS is `dbfs` dB re full-scale amplitude 1.0 (a full-scale sine reads −3.01). */
export function sineAmplitudeForRmsDbfs(dbfs: number): number {
  return Math.SQRT2 * 10 ** (dbfs / 20);
}

export type Tone = { f: number; amplitude: number; phase?: number };

/** Sum of sines, `durationS` long (sample count = round(durationS·fs)), starting at sample `startSample` of the tones' clock. */
export function multitone(fs: number, tones: Tone[], durationS: number, startSample = 0): Float32Array {
  const n = Math.round(durationS * fs);
  const out = new Float32Array(n);
  for (const t of tones) {
    const w = (2 * Math.PI * t.f) / fs;
    const ph = t.phase ?? 0;
    for (let i = 0; i < n; i++) out[i] += t.amplitude * Math.sin(w * (i + startSample) + ph);
  }
  return out;
}

export function sine(fs: number, f: number, amplitude: number, durationS: number, phase = 0): Float32Array {
  return multitone(fs, [{ f, amplitude, phase }], durationS);
}

/**
 * "Pink" multitone (V1_PLAN P1 step 3): one tone per exact one-third-octave frequency 10^(n/10), n = fromN..toN (default
 * 20 Hz–16 kHz = 30 tones), equal amplitude (equal power per third octave = equal power per octave), random phases from
 * `seed`. `totalRmsDbfs` = RMS of the sum re 1.0.
 */
export function pinkTones(totalRmsDbfs: number, seed = 1, fromN = 13, toN = 42): Tone[] {
  const rnd = seededRandom(seed);
  const count = toN - fromN + 1;
  const amp = Math.SQRT2 * 10 ** (totalRmsDbfs / 20) / Math.sqrt(count);
  const tones: Tone[] = [];
  for (let n = fromN; n <= toN; n++) tones.push({ f: 10 ** (n / 10), amplitude: amp, phase: 2 * Math.PI * rnd() });
  return tones;
}

/**
 * Tone burst (IEC 61672-1 toneburst: whole cycles, starting and ending at a zero crossing) of `burstMs` inside silence:
 * `leadS` of silence, the burst, then `tailS` of silence. The cycle count is round(burstMs·f/1000) (≥ 1).
 */
export function toneBurst(fs: number, f: number, amplitude: number, burstMs: number, leadS: number, tailS: number) {
  const cycles = Math.max(1, Math.round((burstMs * f) / 1000));
  const burstSamples = Math.round((cycles / f) * fs);
  const lead = Math.round(leadS * fs);
  const out = new Float32Array(lead + burstSamples + Math.round(tailS * fs));
  const w = (2 * Math.PI * f) / fs;
  for (let i = 0; i < burstSamples; i++) out[lead + i] = amplitude * Math.sin(w * i);
  return { pcm: out, cycles, burstS: cycles / f };
}

/** Hard-clips a signal at ±limit (A4 overload tests). */
export function clipped(signal: Float32Array, limit: number): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-limit, Math.min(limit, signal[i]));
  return out;
}

/** Quantises to signed 16-bit and back (an Android PCM16 source). */
export function toPcm16(signal: Float32Array): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(signal[i] * 32768))) / 32768;
  return out;
}

/** Splits a signal into buffers of `size` samples (last one shorter). */
export function chunks(signal: Float32Array, size: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < signal.length; i += size) out.push(signal.subarray(i, Math.min(signal.length, i + size)));
  return out;
}

/**
 * A level script segment for record-level tests (events, dose, nights): `seconds` of 1-s records whose LAeq,1s is `db`
 * (LAFmax = `lafmax` ?? db, LCeq = `lc` ?? db, LAS = db), or missing seconds when `db` is null.
 */
export type ScriptSegment = { seconds: number; db: number | null; lafmax?: number; lc?: number; flags?: number };

export function recordsFromScript(startMs: number, segments: readonly ScriptSegment[]): SecondRecord[] {
  const out: SecondRecord[] = [];
  let t = startMs;
  for (const s of segments) {
    for (let i = 0; i < s.seconds; i++, t += 1000) {
      if (s.db === null) continue;
      const lc = s.lc ?? s.db;
      out.push({
        tMs: t,
        laeq: s.db,
        lceq: lc,
        lzeq: lc,
        lafmax: s.lafmax ?? s.db,
        lafmin: s.db,
        las: s.db,
        lcpeak: lc + 3,
        flags: s.flags ?? 0,
      });
    }
  }
  return out;
}
