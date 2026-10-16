// Frequency weightings A, C, Z (IEC 61672-1, SPEC §7.2) as digital biquad cascades for any sample rate.
//
// Design (D25, measured): the low-frequency factors (two poles at f1, one at f2, one at f3, the zeros at 0 Hz) use the
// bilinear transform — its warping is negligible there. The double pole at f4 = 12194 Hz uses a magnitude-matched
// low-pass (biquad.ts matchedLowpass) instead of the bilinear transform. That replaces the "HF correction stage" of the
// spec: same number of sections, error ≤ 0.03 dB to 12.5 kHz and +0.26 dB at 16 kHz at 44.1 kHz (bilinear: −3.5 / −8.2 dB).
import { bilinearHighpassPair, bilinearLowpassDouble, butterworthHighpass, magnitude, matchedLowpass, type Cascade } from './biquad';

export type Weighting = 'A' | 'C' | 'Z';

/** Pole frequencies of IEC 61672-1 equations (6)/(7), as used in SPEC §7.2. */
export const F1 = 20.598997;
export const F2 = 107.65265;
export const F3 = 737.86223;
export const F4 = 12194.217;

const sq = (x: number) => x * x;

function rA(f: number): number {
  const f2 = f * f;
  return (sq(F4) * f2 * f2) / ((f2 + sq(F1)) * Math.sqrt((f2 + sq(F2)) * (f2 + sq(F3))) * (f2 + sq(F4)));
}

function rC(f: number): number {
  const f2 = f * f;
  return (sq(F4) * f2) / ((f2 + sq(F1)) * (f2 + sq(F4)));
}

/** Analog reference weighting in dB, normalised to 0 dB at 1 kHz (the IEC formula). For tests and the reference table. */
export function analogWeightingDb(w: Weighting, f: number): number {
  if (w === 'Z') return 0;
  return w === 'A' ? 20 * Math.log10(rA(f) / rA(1000)) : 20 * Math.log10(rC(f) / rC(1000));
}

export type DesignMethod = 'matched' | 'bilinear';

/**
 * Lowest sample rate the meter accepts (review S7, D30). Below 44.1 kHz the f4 pole pair sits too close to Nyquist:
 * at 16 kHz (Bluetooth HFP) A reads −3.85 dB at 5 kHz, at 8 kHz f4 is above Nyquist — outside SPEC A1.
 */
export const MIN_SAMPLE_RATE = 44100;

export function isSupportedSampleRate(fs: number): boolean {
  return Number.isFinite(fs) && fs >= MIN_SAMPLE_RATE;
}

export function assertSupportedSampleRate(fs: number): void {
  if (!isSupportedSampleRate(fs)) throw new Error(`sample rate ${fs} Hz is below ${MIN_SAMPLE_RATE} Hz: levels would be outside SPEC A1`);
}

/**
 * Z: flat, but without DC (review S6, D30). A second-order Butterworth high-pass at 2 Hz removes a DC offset of the
 * converter (which would otherwise dominate LZeq) and costs −0.007 dB at 10 Hz and −0.0004 dB at 20 Hz — far inside
 * the Z tolerance of IEC 61672-1 (10 Hz–20 kHz flat).
 */
export const Z_DC_CUTOFF_HZ = 2;

/**
 * Digital weighting cascade for sample rate `fs`. `method: 'bilinear'` = plain bilinear transform for every pole
 * (kept only to print the error table in tests); the app always uses 'matched'. Z = the 2-Hz DC blocker only.
 * Design only: any fs is accepted here (tests print other rates); the meter refuses fs < MIN_SAMPLE_RATE.
 */
export function designWeighting(w: Weighting, fs: number, method: DesignMethod = 'matched'): Cascade {
  if (w === 'Z') return { gain: 1, sections: [butterworthHighpass(Z_DC_CUTOFF_HZ, fs)] };
  const hf = method === 'matched' ? matchedLowpass(F4, 0.5, fs) : bilinearLowpassDouble(F4, fs);
  const sections =
    w === 'A'
      ? [bilinearHighpassPair(F1, F1, fs), bilinearHighpassPair(F2, F3, fs), hf]
      : [bilinearHighpassPair(F1, F1, fs), hf];
  const cascade: Cascade = { gain: 1, sections };
  cascade.gain = 1 / magnitude(cascade, 1000, fs);
  return cascade;
}

/** Digital response of a weighting at `f` in dB. */
export function digitalWeightingDb(w: Weighting, f: number, fs: number, method: DesignMethod = 'matched'): number {
  return 20 * Math.log10(magnitude(designWeighting(w, fs, method), f, fs));
}

/** Exact base-10 one-third-octave frequencies 10^(n/10) Hz (SPEC §7.2), n from `from` to `to`. */
export function thirdOctaveFrequencies(from = 10, to = 42): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(10 ** (n / 10));
  return out;
}
