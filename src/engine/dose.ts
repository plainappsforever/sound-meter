// Noise dose and exposure estimates (SPEC §7.6; sources RESEARCH §3.5). Information only — the UI says
// "Estimated dose by the NIOSH formula", never "safe" or "compliant" (SPEC §3.4, L26).
//   NIOSH REL: criterion 85 dBA, exchange 3 dB, threshold 80 dBA (assumption per secondary sources), LAeq,1s.
//     https://www.cdc.gov/niosh/noise/about/noise.html (NIOSH 98-126)
//   OSHA PEL: criterion 90 dBA, exchange 5 dB, threshold 80 dBA, slow response (LAS per second).
//     https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.95AppA
//   EU 2003/10/EC: LEX,8h = LAeq,Te + 10·log10(Te / 8 h); action values 80/85 dB(A), limit 87; peaks 135/137/140 dB(C).
//     https://osha.europa.eu/en/legislation/directives/82
import type { SecondRecord } from './dsp/meter';
import { energyMean, isValid } from './levels';

export type DoseRule = 'niosh' | 'osha' | 'eu';

export const EIGHT_HOURS_S = 8 * 3600;

const RULES = {
  niosh: { criterion: 85, exchange: 3, threshold: 80 },
  osha: { criterion: 90, exchange: 5, threshold: 80 },
} as const;

/** EU 2003/10/EC reference values (art. 3). */
export const EU_LEVELS = {
  lowerAction: { lex8h: 80, peak: 135 },
  upperAction: { lex8h: 85, peak: 137 },
  limit: { lex8h: 87, peak: 140 },
} as const;

/** Allowed time in seconds at level L: T = 8 h / 2^((L − criterion)/exchange). */
export function allowedSeconds(rule: 'niosh' | 'osha', level: number): number {
  const r = RULES[rule];
  return EIGHT_HOURS_S / 2 ** ((level - r.criterion) / r.exchange);
}

export type DoseResult = {
  rule: 'niosh' | 'osha';
  /** Dose in % of the daily allowance. */
  dosePct: number;
  /** Time-weighted average (dBA) over 8 h. NaN for a zero dose. */
  twa: number;
  /** "If the rest of an 8-hour day is like this": D · 8 h / measured time. */
  projectedPct: number;
  measuredS: number;
};

export type ExposureResult = {
  rule: 'eu';
  laeqTe: number;
  teS: number;
  lex8h: number;
  lcpeakMax: number;
  /** Projected LEX,8h if the measured LAeq lasted the whole 8 h (= LAeq,Te). */
  projectedLex8h: number;
};

/** Dose from levels with 1-s durations; levels below the threshold add nothing. */
export function doseFromLevels(rule: 'niosh' | 'osha', levels: readonly number[], secondsEach = 1): DoseResult {
  const r = RULES[rule];
  let d = 0;
  for (const l of levels) if (l >= r.threshold) d += secondsEach / allowedSeconds(rule, l);
  const dosePct = 100 * d;
  const twa =
    dosePct > 0
      ? rule === 'niosh'
        ? 10 * Math.log10(dosePct / 100) + 85
        : 16.61 * Math.log10(dosePct / 100) + 90
      : NaN;
  const measuredS = levels.length * secondsEach;
  return { rule, dosePct, twa, projectedPct: measuredS > 0 ? (dosePct * EIGHT_HOURS_S) / measuredS : 0, measuredS };
}

/** LEX,8h from an LAeq over Te seconds. */
export function lex8h(laeqTe: number, teS: number): number {
  return laeqTe + 10 * Math.log10(teS / EIGHT_HOURS_S);
}

export function dose(records: readonly SecondRecord[], rule: 'niosh' | 'osha'): DoseResult;
export function dose(records: readonly SecondRecord[], rule: 'eu'): ExposureResult;
export function dose(records: readonly SecondRecord[], rule: DoseRule): DoseResult | ExposureResult;
/** Dose/exposure over valid seconds (NIOSH: LAeq,1s; OSHA: LAS at the end of each second, slow response). */
export function dose(records: readonly SecondRecord[], rule: DoseRule): DoseResult | ExposureResult {
  const valid = records.filter(isValid);
  if (rule === 'eu') {
    const laeqTe = energyMean(valid.map((r) => r.laeq));
    const teS = valid.length;
    const lcpeakMax = valid.reduce((m, r) => (r.lcpeak > m ? r.lcpeak : m), valid.length ? -Infinity : NaN);
    return { rule, laeqTe, teS, lex8h: teS > 0 ? lex8h(laeqTe, teS) : NaN, lcpeakMax, projectedLex8h: laeqTe };
  }
  return doseFromLevels(
    rule,
    valid.map((r) => (rule === 'osha' ? r.las : r.laeq))
  );
}
