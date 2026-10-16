// Report model (SPEC §7.8): one builder for the night report and the case report. Pure data; report-html.ts renders.
import type { AudioSource, CalibMethod } from './calibration';
import type { SecondRecord } from './dsp/meter';
import { LONG_EVENT_S, nestedPeaks, SENSITIVITY_DB, type Sensitivity } from './events';
import { aggregate, backgroundL90, energyMean, gapLookup, isValid, type Gap, type Summary } from './levels';
import { NIGHT_REPORT_REFERENCES, type ReferenceRow } from './reference';
import { isNightTime, offsetChanges, offsetMinutes, type OffsetChange } from './time';

export type ReportSessionInput = {
  id: number;
  title: string;
  place: string;
  operator: string;
  note: string;
  startedAt: number;
  endedAt: number | null;
  tzName: string;
  profileName: string;
  offsetDb: number;
  calibMethod: CalibMethod;
  calibratedAt: number | null;
  referenceMeter: string;
  deviceModel: string;
  osVersion: string;
  audioSource: AudioSource;
  sampleRate: number;
  appVersion: string;
  sensitivity: Sensitivity;
};

export type ReportEventInput = {
  id: number;
  sessionId: number | null;
  source: 'auto' | 'mark' | 'manual';
  startMs: number;
  endMs: number;
  laeq: number | null;
  lafmax: number | null;
  lcpeak: number | null;
  lceq: number | null;
  lfHint: boolean | null;
  overloadS: number;
  category: string | null;
  categoryOther: string;
  note: string;
  witnesses: string;
  effect: string | null;
  excluded: boolean;
};

export type NightInput = { session: ReportSessionInput; records: readonly SecondRecord[]; gaps: readonly Gap[]; events: readonly ReportEventInput[] };

export type ReportInput = {
  kind: 'night' | 'case';
  caseInfo?: { name: string; address: string; notes: string };
  nights: readonly NightInput[];
  manualEntries?: readonly ReportEventInput[];
  generatedAt: number;
  /** Zone for manual entries and the case period when there is no night; defaults to the first night's zone. */
  tzName?: string;
};

export type CalibrationState = {
  kind: 'calibrated' | 'manual' | 'factory-nominal' | 'placeholder';
  method: CalibMethod;
  offsetDb: number;
  calibratedAt: number | null;
  referenceMeter: string;
};

export type ChartMinute = { tMs: number; laeq: number; lmax: number } | { tMs: number; laeq: null; lmax: null };

export type NightModel = {
  sessionId: number;
  title: string;
  place: string;
  operator: string;
  note: string;
  startMs: number;
  endMs: number;
  tzName: string;
  startOffsetMin: number;
  endOffsetMin: number;
  offsetChanges: OffsetChange[];
  calibration: CalibrationState;
  deviceModel: string;
  osVersion: string;
  audioSource: AudioSource;
  sampleRate: number;
  appVersion: string;
  sensitivity: Sensitivity;
  deltaDb: number;
  summary: Summary;
  backgroundDb: number;
  /** Included events in time order — top-level events AND the nested peaks of long events (listed under them). */
  events: ReportEventInput[];
  excluded: ReportEventInput[];
  /** Nested peak id → id of its long event (D29 a). */
  peakOf: Record<number, number>;
  /** Number of events without the nested peaks (summary "Events"). */
  eventCount: number;
  events2206: number;
  gaps: Gap[];
  chart: ChartMinute[];
};

export type ReportModel = {
  kind: 'night' | 'case';
  caseInfo: { name: string; address: string; notes: string } | null;
  periodStartMs: number | null;
  periodEndMs: number | null;
  tzName: string;
  nights: NightModel[];
  manualEntries: ReportEventInput[];
  references: readonly ReferenceRow[];
  overloadS: number;
  generatedAt: number;
};

export function calibrationState(s: Pick<ReportSessionInput, 'calibMethod' | 'offsetDb' | 'calibratedAt' | 'referenceMeter' | 'audioSource'>): CalibrationState {
  const kind =
    s.calibMethod === 'reference-meter'
      ? 'calibrated'
      : s.calibMethod === 'manual-entry'
        ? 'manual'
        : s.audioSource === 'unprocessed'
          ? 'factory-nominal'
          : 'placeholder';
  return { kind, method: s.calibMethod, offsetDb: s.offsetDb, calibratedAt: s.calibratedAt, referenceMeter: s.referenceMeter };
}

/**
 * 1-minute LAeq and maximum LAFmax from the 1-s series; minutes without valid seconds are null (drawn as gaps).
 * Seconds inside gaps are left out, as in the summary and the events (review S3).
 */
export function chartMinutes(records: readonly SecondRecord[], startMs: number, endMs: number, gaps: readonly Gap[] = []): ChartMinute[] {
  const out: ChartMinute[] = [];
  const inGap = gapLookup(gaps);
  const valid = records.filter((r) => isValid(r) && !inGap(r.tMs));
  let i = 0;
  for (let t = startMs; t < endMs; t += 60_000) {
    const levels: number[] = [];
    let lmax = -Infinity;
    while (i < valid.length && valid[i].tMs < t) i++;
    let j = i;
    while (j < valid.length && valid[j].tMs < t + 60_000) {
      levels.push(valid[j].laeq);
      if (valid[j].lafmax > lmax) lmax = valid[j].lafmax;
      j++;
    }
    out.push(levels.length ? { tMs: t, laeq: energyMean(levels), lmax } : { tMs: t, laeq: null, lmax: null });
  }
  return out;
}

function nightModel(n: NightInput): NightModel {
  const s = n.session;
  const sorted = [...n.records].sort((a, b) => a.tMs - b.tMs);
  const endMs = s.endedAt ?? (sorted.length ? sorted[sorted.length - 1].tMs + 1000 : s.startedAt);
  const events = [...n.events].sort((a, b) => a.startMs - b.startMs);
  const included = events.filter((e) => !e.excluded);
  const nested = nestedPeaks(included);
  const top = included.filter((e) => !nested.has(e.id));
  const peakOf: Record<number, number> = {};
  for (const [child, parent] of nested) peakOf[child] = parent.id;
  return {
    sessionId: s.id,
    title: s.title,
    place: s.place,
    operator: s.operator,
    note: s.note,
    startMs: s.startedAt,
    endMs,
    tzName: s.tzName,
    startOffsetMin: offsetMinutes(s.startedAt, s.tzName),
    endOffsetMin: offsetMinutes(endMs, s.tzName),
    offsetChanges: offsetChanges(s.startedAt, endMs, s.tzName),
    calibration: calibrationState(s),
    deviceModel: s.deviceModel,
    osVersion: s.osVersion,
    audioSource: s.audioSource,
    sampleRate: s.sampleRate,
    appVersion: s.appVersion,
    sensitivity: s.sensitivity,
    deltaDb: SENSITIVITY_DB[s.sensitivity],
    summary: aggregate(sorted, n.gaps, { startMs: s.startedAt, endMs }),
    backgroundDb: backgroundL90(sorted, included, n.gaps),
    events: included,
    excluded: events.filter((e) => e.excluded),
    peakOf,
    eventCount: top.length,
    events2206: top.filter((e) => isNightTime(e.startMs, s.tzName)).length,
    gaps: [...n.gaps].sort((a, b) => a.startMs - b.startMs),
    chart: chartMinutes(sorted, s.startedAt, endMs, n.gaps),
  };
}

/** D29 (a): a measured auto event longer than 10 min. */
export function isLongEvent(e: Pick<ReportEventInput, 'source' | 'startMs' | 'endMs'>): boolean {
  return e.source === 'auto' && e.endMs - e.startMs > LONG_EVENT_S * 1000;
}

export function buildReport(input: ReportInput): ReportModel {
  const nights = [...input.nights].sort((a, b) => a.session.startedAt - b.session.startedAt).map(nightModel);
  const manual = [...(input.manualEntries ?? [])].sort((a, b) => a.startMs - b.startMs);
  const starts = [...nights.map((n) => n.startMs), ...manual.map((e) => e.startMs)];
  const ends = [...nights.map((n) => n.endMs), ...manual.map((e) => e.endMs)];
  return {
    kind: input.kind,
    caseInfo: input.caseInfo ?? null,
    periodStartMs: starts.length ? Math.min(...starts) : null,
    periodEndMs: ends.length ? Math.max(...ends) : null,
    tzName: input.tzName ?? nights[0]?.tzName ?? 'UTC',
    nights,
    manualEntries: manual,
    references: NIGHT_REPORT_REFERENCES,
    overloadS: nights.reduce((s, n) => s + n.summary.overloadS, 0),
    generatedAt: input.generatedAt,
  };
}
