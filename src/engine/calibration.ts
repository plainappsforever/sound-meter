// Calibration offsets (SPEC §7.1, F6, D18).
import { energyMean } from './levels';

/**
 * Android CDD 5.11: a 94 dB SPL 1 kHz tone gives RMS 520 for 16-bit samples on the UNPROCESSED source
 * (https://source.android.com/docs/compatibility/16/android-16-cdd#5_11_capture_for_unprocessed).
 * offset = 94 − 20·log10(520/32768) = 129.989 dB (re full-scale amplitude 1.0).
 */
export const CDD_REFERENCE_RMS = 520 / 32768;
export const DEFAULT_OFFSET_DB = 94 - 20 * Math.log10(CDD_REFERENCE_RMS);

export type CalibMethod = 'platform-default' | 'reference-meter' | 'manual-entry';
export type AudioSource = 'unprocessed' | 'voice_recognition' | 'mic' | 'ios_measurement';

/** How honest the default is: published nominal (Android UNPROCESSED) or a placeholder assumption (everything else). */
export type DefaultKind = 'factory-nominal' | 'placeholder';

export function platformDefault(source: AudioSource): { offsetDb: number; method: CalibMethod; kind: DefaultKind } {
  return {
    offsetDb: DEFAULT_OFFSET_DB,
    method: 'platform-default',
    kind: source === 'unprocessed' ? 'factory-nominal' : 'placeholder',
  };
}

export const CALIB_MAX_SIGMA_DB = 1.5;
export const CALIB_MAX_DIFF_DB = 40;
/** At least 20 valid 1-s values in the (30-s) window (D25: a window cut short by a gap is not enough). */
export const CALIB_MIN_SECONDS = 20;

export type CalibrationResult =
  | { ok: true; newOffsetDb: number; measuredDb: number; deltaDb: number; sigmaDb: number }
  | { ok: false; reason: 'unsteady' | 'implausible' | 'too-short'; measuredDb: number; sigmaDb: number };

/** Population standard deviation. */
export function stdDev(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/**
 * New offset from a side-by-side reading: the user reads the reference meter's average `referenceDb` (R) over the same
 * window; the app's LAeq over the window with the current offset is M; new offset = offset + (R − M).
 * Rejected when the app's 1-s values have σ > 1.5 dB ("use a steadier sound") or |R − M| > 40 dB (typo).
 */
export function calibrate(currentOffsetDb: number, windowLaeq1s: readonly number[], referenceDb: number): CalibrationResult {
  const finite = windowLaeq1s.filter(Number.isFinite);
  const measuredDb = energyMean(finite);
  const sigmaDb = stdDev(finite);
  if (finite.length < CALIB_MIN_SECONDS) return { ok: false, reason: 'too-short', measuredDb, sigmaDb };
  if (sigmaDb > CALIB_MAX_SIGMA_DB) return { ok: false, reason: 'unsteady', measuredDb, sigmaDb };
  const deltaDb = referenceDb - measuredDb;
  if (!Number.isFinite(referenceDb) || Math.abs(deltaDb) > CALIB_MAX_DIFF_DB)
    return { ok: false, reason: 'implausible', measuredDb, sigmaDb };
  return { ok: true, newOffsetDb: currentOffsetDb + deltaDb, measuredDb, deltaDb, sigmaDb };
}

/** Manual offset entry: plausible range relative to the default (±60 dB) — anything else is a typo. */
export function validManualOffset(offsetDb: number): boolean {
  return Number.isFinite(offsetDb) && Math.abs(offsetDb - DEFAULT_OFFSET_DB) <= 60;
}
