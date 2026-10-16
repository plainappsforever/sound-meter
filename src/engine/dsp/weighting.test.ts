/**
 * @jest-environment node
 */
// A1 (SPEC §15): digital A/C weighting vs the IEC 61672-1 analog formula at exact one-third-octave frequencies.
import { createCascadeFilter } from './biquad';
import { createMeter } from './meter';
import { analogWeightingDb, designWeighting, digitalWeightingDb, thirdOctaveFrequencies } from './weighting';
import { multitone, pinkTones, sine } from '../signals';

/** A1 limits by frequency: ≤ 0.1 dB 20 Hz–5 kHz, ≤ 0.6 at 8 kHz, ≤ 1.3 at 10 kHz, ≤ 3 at 12.5 kHz. */
function a1Limit(f: number): number | null {
  if (f < 19.9) return 0.1; // 10–16 Hz: not in A1; we hold them to 0.1 too (measured ≤ 0.005)
  if (f <= 5100) return 0.1;
  if (f <= 6400) return 0.6;
  if (f <= 8000) return 0.6;
  if (f <= 10100) return 1.3;
  if (f <= 12700) return 3;
  return null; // 16 kHz: reported only
}

describe.each([44100, 48000])('weighting filters at fs = %i Hz (A1)', (fs) => {
  it.each(['A', 'C'] as const)('%s: |digital − analog| within the A1 limits; 16 kHz reported', (w) => {
    const rows: string[] = [];
    for (const f of thirdOctaveFrequencies(10, 42)) {
      const err = digitalWeightingDb(w, f, fs) - analogWeightingDb(w, f);
      rows.push(`${f.toFixed(1)} ${err.toFixed(3)}`);
      const limit = a1Limit(f);
      if (limit !== null) expect([f, Math.abs(err) <= limit]).toEqual([f, true]);
      // Our own, stricter regression bound (D25): the matched f4 pair keeps every band up to 12.5 kHz within 0.04 dB.
      if (f <= 12700) expect([f, Math.abs(err) <= 0.04]).toEqual([f, true]);
      else expect([f, Math.abs(err) <= 0.3]).toEqual([f, true]);
    }
    if (process.env.PRINT_TABLES) console.log(`${w} @ ${fs}\n${rows.join('\n')}`);
  });

  it('the plain bilinear design (kept for comparison) fails A1 above 5 kHz — the reason for the matched pair', () => {
    const err8k = digitalWeightingDb('A', 10 ** 3.9, fs, 'bilinear') - analogWeightingDb('A', 10 ** 3.9);
    expect(err8k).toBeLessThan(-0.5);
  });

  it('time-domain sines through the meter match the designed response within 0.01 dB (processing = design)', () => {
    for (const f of [10 ** 1.3, 10 ** 2, 10 ** 3, 10 ** 3.6, 10 ** 3.9, 10 ** 4.1]) {
      const amp = 0.1;
      const meter = createMeter({ fs, offsetDb: 0 });
      meter.process(sine(fs, f, amp, 6), 0);
      const recs = meter.drainSeconds().slice(1);
      const mean = (k: 'laeq' | 'lceq' | 'lzeq') =>
        10 * Math.log10(recs.reduce((s, r) => s + 10 ** (r[k] / 10), 0) / recs.length);
      const lz = mean('lzeq');
      expect(Math.abs(lz - 20 * Math.log10(amp / Math.SQRT2))).toBeLessThan(0.01);
      expect(Math.abs(mean('laeq') - lz - digitalWeightingDb('A', f, fs))).toBeLessThan(0.01);
      expect(Math.abs(mean('lceq') - lz - digitalWeightingDb('C', f, fs))).toBeLessThan(0.01);
    }
  });

  it('multi-tone "pink" (30 tones 20 Hz–16 kHz, equal power per octave, seeded phases): LA, LC within 0.1 dB of analytic', () => {
    for (const seed of [1, 2, 3]) {
      const tones = pinkTones(-20, seed);
      const pcm = multitone(fs, tones, 11);
      const meter = createMeter({ fs, offsetDb: 0 });
      meter.process(pcm, 0);
      const recs = meter.drainSeconds().slice(1);
      const mean = (k: 'laeq' | 'lceq') => 10 * Math.log10(recs.reduce((s, r) => s + 10 ** (r[k] / 10), 0) / recs.length);
      const analytic = (w: 'A' | 'C') =>
        10 * Math.log10(tones.reduce((s, t) => s + (t.amplitude ** 2 / 2) * 10 ** (analogWeightingDb(w, t.f) / 10), 0));
      expect(Math.abs(mean('laeq') - analytic('A'))).toBeLessThan(0.1);
      expect(Math.abs(mean('lceq') - analytic('C'))).toBeLessThan(0.1);
      // measured margin (D25): ≤ 0.02 dB
      expect(Math.abs(mean('laeq') - analytic('A'))).toBeLessThan(0.02);
    }
  });
});

describe('E2 weighting worked examples (formula values at exact frequencies, A1 tolerances)', () => {
  it('100 Hz at LZ 94.0 → LA 74.86, LC 93.70; 63.1 Hz → A −26.2, C −0.8; 4 kHz → A +0.96', () => {
    const fs = 48000;
    expect(Math.abs(94 + digitalWeightingDb('A', 100, fs) - 74.86)).toBeLessThan(0.01);
    expect(Math.abs(94 + digitalWeightingDb('C', 100, fs) - 93.7)).toBeLessThan(0.01);
    expect(digitalWeightingDb('A', 10 ** 1.8, fs).toFixed(1)).toBe('-26.2');
    expect(digitalWeightingDb('C', 10 ** 1.8, fs).toFixed(1)).toBe('-0.8');
    expect(Math.abs(digitalWeightingDb('A', 4000, fs) - 0.96)).toBeLessThan(0.01);
  });

  it('the formula differs from the rounded IEC table at nominal frequencies (SPEC §7.2: A(31.5) = −39.52)', () => {
    expect(analogWeightingDb('A', 31.5).toFixed(2)).toBe('-39.52');
    expect(analogWeightingDb('A', 10 ** 1.5).toFixed(1)).toBe('-39.4');
  });

  it('Z is flat 10 Hz–20 kHz (≤ 0.01 dB) but blocks DC (review S6); every cascade is unity at 1 kHz', () => {
    for (const fs of [44100, 48000]) {
      for (const f of thirdOctaveFrequencies(10, 43)) expect([fs, f, Math.abs(digitalWeightingDb('Z', f, fs)) < 0.01]).toEqual([fs, f, true]);
      expect(digitalWeightingDb('Z', 0.01, fs)).toBeLessThan(-60);
      const z = createCascadeFilter(designWeighting('Z', fs));
      let y = 0;
      for (let i = 0; i < 2 * fs; i++) y = z.step(0.25); // 2 s of DC
      expect(Math.abs(y)).toBeLessThan(1e-6);
    }
    expect(Math.abs(digitalWeightingDb('Z', 1000, 48000))).toBeLessThan(1e-6);
    for (const fs of [8000, 16000, 22050, 32000, 44100, 48000, 96000])
      for (const w of ['A', 'C'] as const) expect(Math.abs(digitalWeightingDb(w, 1000, fs))).toBeLessThan(1e-9);
  });

  it('other sample rates keep 20 Hz–4 kHz within 0.1 dB (NI14: coefficients per fs)', () => {
    for (const fs of [32000, 88200, 96000])
      for (const f of thirdOctaveFrequencies(13, 36))
        for (const w of ['A', 'C'] as const)
          expect([fs, f, Math.abs(digitalWeightingDb(w, f, fs) - analogWeightingDb(w, f)) < 0.1]).toEqual([fs, f, true]);
  });
});
