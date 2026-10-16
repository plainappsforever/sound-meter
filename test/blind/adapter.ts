// Blind-set adapter (WORKFLOW L27, blind-set protocol): runs OUR engine over a blind fixture set written by a separate
// agent (test/blind/set-1/, format in its FORMAT.md) and emits the engine's values in the shape of the set's
// expected/*.json, each next to the expectation, with pass/fail by the set's own comparison rule (check.py `cmp`).
// The set's check.py only recomputes the expectations from the files (it validates the referee, not the engine); this
// adapter is the engine side. It uses only public engine functions, the way the app does:
//   signals: createMeter (100-ms buffers, flush at the end like capture.ts finish) → stored records; a second meter fed
//            sample by sample and read through live() gives the engine's Z-Fast and A-Slow detector values (not stored).
//   nights:  decodeBlock (the stored 900-byte blocks) + the night's gap rows → detectEvents / aggregate / backgroundL90 /
//            isNightTime, exactly as finaliseSession (src/db/sessions.ts) and the report (src/engine/report.ts) do.
//   dose:    parseCsv on the dose CSV → records → dose('niosh' | 'osha' | 'eu').
// Quantities the engine does not compute at all (Z peak, C-Slow, Z-Slow) are reported as "not produced", not as fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeBlock } from '../../src/engine/codec';
import { parseCsv } from '../../src/engine/csv';
import { dose } from '../../src/engine/dose';
import { createMeter, FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL, type SecondRecord } from '../../src/engine/dsp/meter';
import { detectEvents, type Sensitivity } from '../../src/engine/events';
import { aggregate, backgroundL90, energyMean, isValid, lfHint, percentileLN, type Gap } from '../../src/engine/levels';
import { isNightTime } from '../../src/engine/time';

export type Assertion = {
  quantity: string;
  second: number | null;
  range?: [number, number];
  expected: number | null;
  tol?: number;
  lo?: number;
  hi?: number;
  offset_db?: number;
  status: string;
  missing?: boolean;
  nocheck?: boolean;
  info_only?: boolean;
  initial_state_assumption?: boolean;
  spec_weakness?: boolean;
  iec_table?: boolean;
  burst_second?: number;
  ref_second?: number;
  basis?: string;
};
export type SignalFixture = { id: string; name: string; file: string; fs: number; status: string; assertions: Assertion[] };

/** Mono IEEE-float32 WAV (format tag 3, or extensible with a float sub-format). */
export function readWav(path: string): { fs: number; x: Float32Array } {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV`);
  let off = 12;
  let fs = 0;
  let x: Float32Array | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      const tag = b.readUInt16LE(body);
      const ch = b.readUInt16LE(body + 2);
      fs = b.readUInt32LE(body + 4);
      const bits = b.readUInt16LE(body + 14);
      if ((tag !== 3 && tag !== 0xfffe) || ch !== 1 || bits !== 32) throw new Error(`${path}: expected mono float32`);
    } else if (id === 'data') {
      const n = size / 4;
      x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readFloatLE(body + 4 * i);
    }
    off = body + size + (size & 1);
  }
  if (!x || !fs) throw new Error(`${path}: no data`);
  return { fs, x };
}

const T0 = Date.UTC(2026, 9, 16, 22, 0, 0); // arbitrary grid origin for the PCM runs

type SecondTaps = { lzfmax: number; lzfmin: number; lasmax: number };
export type SignalRun = { records: (SecondRecord | undefined)[]; taps: SecondTaps[] };

export function runSignal(x: Float32Array, fs: number, offsetDb: number): SignalRun {
  // Stored records: 100-ms buffers aligned to the file start (FORMAT.md), flush at the end (capture.ts finish()).
  const meter = createMeter({ fs, offsetDb });
  const buf = Math.round(fs / 10);
  for (let i = 0; i < x.length; i += buf) meter.process(x.subarray(i, Math.min(x.length, i + buf)), T0 + (i * 1000) / fs);
  meter.flush();
  const records: (SecondRecord | undefined)[] = [];
  for (const r of meter.drainSeconds()) records[Math.round((r.tMs - T0) / 1000)] = r;
  // Live detector values, sample by sample (the engine's display path).
  const live = createMeter({ fs, offsetDb });
  const one = new Float32Array(1);
  const taps: SecondTaps[] = [];
  for (let i = 0; i < x.length; i++) {
    one[0] = x[i];
    live.process(one, T0 + (i * 1000) / fs);
    const v = live.live();
    const s = Math.floor(i / fs);
    const t = (taps[s] ??= { lzfmax: -Infinity, lzfmin: Infinity, lasmax: -Infinity });
    if (v.lzf > t.lzfmax) t.lzfmax = v.lzf;
    if (v.lzf < t.lzfmin) t.lzfmin = v.lzf;
    if (v.las > t.lasmax) t.lasmax = v.las;
  }
  return { records, taps };
}

export const NOT_PRODUCED = new Set(['LZpeak_1s', 'LZpeak', 'LCS_end', 'LZS_end', 'LZSmax', 'burst_delta_ZS', 'LCFmax_1s', 'LCFmax']);
const STORED: Record<string, keyof SecondRecord> = {
  LAeq_1s: 'laeq',
  LCeq_1s: 'lceq',
  LZeq_1s: 'lzeq',
  LAFmax_1s: 'lafmax',
  LAFmin_1s: 'lafmin',
  LAS_end: 'las',
  LCpeak_1s: 'lcpeak',
};
const FLAGS: Record<string, number> = { overload: FLAG_OVERLOAD, partial: FLAG_PARTIAL, mic_busy: FLAG_MIC_BUSY };

const fin = (v: number | undefined): number | null => (v !== undefined && Number.isFinite(v) ? v : null);

export function measure(run: SignalRun, a: Assertion): number | null {
  const { records, taps } = run;
  const q = a.quantity;
  if (a.second !== null && a.second !== undefined) {
    const r = records[a.second];
    if (q in FLAGS) return r ? ((r.flags & FLAGS[q]) !== 0 ? 1 : 0) : null;
    if (q in STORED) return r ? fin(r[STORED[q]] as number) : null;
    const t = taps[a.second];
    if (q === 'LZFmax_1s') return t ? fin(t.lzfmax) : null;
    if (q === 'LZFmin_1s') return t ? fin(t.lzfmin) : null;
    throw new Error(`unknown per-second quantity ${q}`);
  }
  const [s0, s1] = a.range ?? [0, records.length];
  const recs: SecondRecord[] = [];
  for (let i = s0; i < s1; i++) {
    const r = records[i];
    if (r && isValid(r)) recs.push(r);
  }
  const max = (xs: number[]) => (xs.length ? xs.reduce((m, v) => (v > m ? v : m), -Infinity) : null);
  switch (q) {
    case 'LAeq':
      return fin(energyMean(recs.map((r) => r.laeq)));
    case 'LCeq':
      return fin(energyMean(recs.map((r) => r.lceq)));
    case 'LZeq':
      return fin(energyMean(recs.map((r) => r.lzeq)));
    case 'LAFmax':
      return max(recs.map((r) => r.lafmax));
    case 'LCpeak':
      return max(recs.map((r) => r.lcpeak));
    case 'LASmax': {
      const xs: number[] = [];
      for (let i = s0; i < s1; i++) if (taps[i] && records[i] && isValid(records[i]!)) xs.push(taps[i].lasmax);
      return max(xs);
    }
    case 'L10':
    case 'L50':
    case 'L90':
      return fin(percentileLN(recs.map((r) => r.laeq), Number(q.slice(1))));
    case 'LCeq_minus_LAeq':
      return fin(lfHint(energyMean(recs.map((r) => r.lceq)), energyMean(recs.map((r) => r.laeq))).diffDb);
    case 'burst_delta_AF':
    case 'burst_delta_AS':
    case 'burst_delta_ZF': {
      const b = a.burst_second!;
      const ref = records[a.ref_second!];
      const top =
        q === 'burst_delta_AF' ? records[b]?.lafmax : q === 'burst_delta_AS' ? taps[b]?.lasmax : taps[b]?.lzfmax;
      const base = q === 'burst_delta_ZF' ? ref?.lzeq : ref?.laeq;
      return top === undefined || base === undefined ? null : fin(top - base);
    }
    default:
      throw new Error(`unknown range quantity ${q}`);
  }
}

/** check.py `cmp`, plus "missing" assertions (the engine must output no value). */
export function judge(a: Assertion, measured: number | null): boolean {
  if (a.missing) return measured === null;
  if (measured === null) return false;
  const e = a.expected ?? 0;
  if (e === Infinity || e === -Infinity) return measured === e;
  if (a.lo !== undefined || a.hi !== undefined) return (a.lo ?? -1e9) - 1e-9 <= measured && measured <= (a.hi ?? 1e9) + 1e-9;
  return Math.abs(measured - e) <= (a.tol ?? 0) + 1e-9;
}

export type SignalOutcome = 'pass' | 'fail' | 'not-produced' | 'info-pass' | 'info-fail';
export type SignalResult = { id: string; name: string; status: string; assertions: (Assertion & { measured: number | null; outcome: SignalOutcome })[] };

export function runSignals(dir: string): SignalResult[] {
  const fixtures = (JSON.parse(readFileSync(join(dir, 'expected/signals.json'), 'utf8')) as { fixtures: SignalFixture[] }).fixtures;
  const out: SignalResult[] = [];
  for (const fx of fixtures) {
    const { fs, x } = readWav(join(dir, fx.file));
    if (fs !== fx.fs) throw new Error(`${fx.id}: fs ${fs} ≠ ${fx.fs}`);
    const runs = new Map<number, SignalRun>();
    const runAt = (o: number) => {
      if (!runs.has(o)) runs.set(o, runSignal(x, fs, o));
      return runs.get(o)!;
    };
    const assertions = fx.assertions.map((a) => {
      if (NOT_PRODUCED.has(a.quantity)) return { ...a, measured: null, outcome: 'not-produced' as const };
      const measured = measure(runAt(a.offset_db ?? 0), a);
      const ok = judge(a, measured);
      const outcome: SignalOutcome = a.info_only ? (ok ? 'info-pass' : 'info-fail') : ok ? 'pass' : 'fail';
      return { ...a, measured, outcome };
    });
    out.push({ id: fx.id, name: fx.name, status: fx.status, assertions });
  }
  return out;
}

// ---------------------------------------------------------------- nights
type NightSpec = {
  id: string;
  name: string;
  status: string;
  blocks: string;
  tz: string;
  start_utc_ms: number;
  n_seconds: number;
  sensitivity_db: number;
  gaps: { start_ms: number; end_ms: number; reason: Gap['reason'] }[];
  expected_events: Record<string, NightEvent[]>;
  expected_summary: Record<string, number | null>;
  variant_results?: Record<string, [number, number][]>;
};
export type NightEvent = {
  start_s: number;
  end_s: number;
  duration_s: number;
  LAeq: number;
  LCeq: number;
  LAFmax: number;
  LCpeak: number;
  lf_hint: number;
  overload_s: number;
};
const SENS: Record<string, Sensitivity> = { '6': 'high', '10': 'normal', '15': 'low' };

export type NightResult = {
  id: string;
  name: string;
  status: string;
  events: Record<string, NightEvent[]>;
  summary: Record<string, number | null>;
  checks: { what: string; ok: boolean; detail: string }[];
  /** For variant-sensitive nights: which reading (primary or a variant from variant_results) the engine's events equal. */
  variantMatch?: string[];
};

function readNight(dir: string, nt: NightSpec): SecondRecord[] {
  const j = JSON.parse(readFileSync(join(dir, nt.blocks), 'utf8')) as { blocks: { startMs: number; data: string }[] };
  const recs: SecondRecord[] = [];
  for (const b of j.blocks) recs.push(...decodeBlock(b.startMs, new Uint8Array(Buffer.from(b.data, 'base64'))));
  return recs;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function runNights(dir: string): NightResult[] {
  const spec = JSON.parse(readFileSync(join(dir, 'expected/nights.json'), 'utf8')) as { nights: NightSpec[] };
  const out: NightResult[] = [];
  for (const nt of spec.nights) {
    const records = readNight(dir, nt);
    const gaps: Gap[] = nt.gaps.map((g) => ({ startMs: g.start_ms, endMs: g.end_ms, reason: g.reason }));
    const startMs = nt.start_utc_ms;
    const endMs = startMs + nt.n_seconds * 1000;
    const checks: NightResult['checks'] = [];
    const events: Record<string, NightEvent[]> = {};
    let primaryCandidates: ReturnType<typeof detectEvents> = [];
    for (const [sens, exp] of Object.entries(nt.expected_events)) {
      const cand = detectEvents(records, gaps, { sensitivity: SENS[sens], sessionStartMs: startMs, sessionEndMs: endMs });
      if (Number(sens) === nt.sensitivity_db) primaryCandidates = cand;
      const got = cand.map((c) => ({
        start_s: (c.startMs - startMs) / 1000,
        end_s: (c.endMs - startMs) / 1000,
        duration_s: (c.endMs - c.startMs) / 1000,
        LAeq: r4(c.laeq),
        LCeq: r4(c.lceq),
        LAFmax: r4(c.lafmax),
        LCpeak: r4(c.lcpeak),
        lf_hint: c.lfHint ? 1 : 0,
        overload_s: c.overloadS,
      }));
      events[sens] = got;
      checks.push({ what: `delta ${sens}: count`, ok: got.length === exp.length, detail: `${got.length} (expected ${exp.length})` });
      // Pair events by order only when the counts agree; otherwise list which expected intervals were found exactly.
      const found = exp.filter((e) => got.some((g) => g.start_s === e.start_s && g.end_s === e.end_s)).length;
      checks.push({ what: `delta ${sens}: start/end exact`, ok: found === exp.length && got.length === exp.length, detail: `${found}/${exp.length} expected intervals found exactly` });
      const within1 = exp.filter((e) => got.some((g) => Math.abs(g.start_s - e.start_s) <= 1 && Math.abs(g.end_s - e.end_s) <= 1)).length;
      checks.push({ what: `delta ${sens}: start/end ±1 s (A5)`, ok: within1 === exp.length && got.length === exp.length, detail: `${within1}/${exp.length}` });
      for (const e of exp) {
        const g = got.find((x) => x.start_s === e.start_s && x.end_s === e.end_s);
        if (!g) continue;
        const bad: string[] = [];
        for (const k of ['LAeq', 'LCeq'] as const) if (Math.abs(g[k] - e[k]) > 0.01 + 1e-9) bad.push(`${k} ${g[k]} vs ${e[k]}`);
        for (const k of ['LAFmax', 'LCpeak'] as const) if (Math.abs(g[k] - e[k]) > 1e-6) bad.push(`${k} ${g[k]} vs ${e[k]}`);
        for (const k of ['lf_hint', 'overload_s', 'duration_s'] as const) if (g[k] !== e[k]) bad.push(`${k} ${g[k]} vs ${e[k]}`);
        checks.push({ what: `delta ${sens}: metrics of ${e.start_s}-${e.end_s}`, ok: bad.length === 0, detail: bad.join('; ') || 'ok' });
      }
    }
    // Summary as finaliseSession + report compute it.
    const s = aggregate(records, gaps);
    const bg = backgroundL90(records, primaryCandidates, gaps);
    const summary: Record<string, number | null> = {
      valid_s: s.validMs / 1000,
      gap_s: s.gapMs / 1000,
      LAeq: fin(r4(s.laeq)),
      L10: fin(s.l10),
      L50: fin(s.l50),
      L90: fin(s.l90),
      LAFmax: fin(s.lafmax),
      LCpeak: fin(s.lcpeak),
      background_B: fin(bg),
      events: primaryCandidates.length,
      events_22_06: primaryCandidates.filter((c) => isNightTime(c.startMs, nt.tz)).length,
    };
    for (const [k, v] of Object.entries(nt.expected_summary)) {
      const g = summary[k];
      const ok = v === null || g === null ? v === g : Math.abs(g - v) <= (k === 'LAeq' ? 0.01 : 1e-6) + 1e-9;
      checks.push({ what: `summary ${k}`, ok, detail: `${g} (expected ${v})` });
    }
    let variantMatch: string[] | undefined;
    if (nt.variant_results) {
      const mine = JSON.stringify(events[String(nt.sensitivity_db)].map((e) => [e.start_s, e.end_s]));
      const primary = JSON.stringify(nt.expected_events[String(nt.sensitivity_db)].map((e) => [e.start_s, e.end_s]));
      const all = ['prev', 'incl'].flatMap((w) => ['span', 'loud'].flatMap((m) => ['none', 'hold'].map((u) => `${w}/${m}/${u}`)));
      variantMatch = all.filter((v) => JSON.stringify(nt.variant_results![v] ?? JSON.parse(primary)) === mine);
    }
    out.push({ id: nt.id, name: nt.name, status: nt.status, events, summary, checks, variantMatch });
  }
  return out;
}

// ---------------------------------------------------------------- dose
type DoseSpec = { id: string; name: string; status: string; csv: string; expected: Record<string, number | null>; tol: Record<string, number> };
export type DoseResult = { id: string; name: string; status: string; values: Record<string, number | null>; checks: { what: string; ok: boolean; detail: string }[] };

export function readSeriesCsv(path: string): SecondRecord[] {
  const rows = parseCsv(readFileSync(path, 'utf8'), ',');
  const head = rows[0];
  const col = (n: string) => head.indexOf(n);
  const num = (s: string) => (s === '' ? NaN : Number(s));
  const out: SecondRecord[] = [];
  for (const row of rows.slice(1)) {
    if (row.length < head.length) continue;
    const levels = ['LAeq_1s', 'LCeq_1s', 'LZeq_1s', 'LAFmax', 'LAFmin', 'LAS', 'LCpeak'].map((n) => num(row[col(n)]));
    let flags = 0;
    if (row[col('overload')] === '1') flags |= FLAG_OVERLOAD;
    if (row[col('partial')] === '1') flags |= FLAG_PARTIAL;
    if (levels.every((v) => Number.isNaN(v))) flags |= FLAG_MIC_BUSY; // a row with empty levels = mic busy (FORMATS.md)
    const [laeq, lceq, lzeq, lafmax, lafmin, las, lcpeak] = levels;
    out.push({ tMs: Date.parse(row[col('time')]), laeq, lceq, lzeq, lafmax, lafmin, las, lcpeak, flags });
  }
  return out;
}

export function runDose(dir: string): DoseResult[] {
  const spec = JSON.parse(readFileSync(join(dir, 'expected/dose.json'), 'utf8')) as { cases: DoseSpec[] };
  return spec.cases.map((c) => {
    const recs = readSeriesCsv(join(dir, c.csv));
    const n = dose(recs, 'niosh');
    const o = dose(recs, 'osha');
    const eu = dose(recs, 'eu');
    const values: Record<string, number | null> = {
      niosh_dose_pct: n.dosePct,
      niosh_twa: fin(n.twa),
      niosh_projected_pct: n.projectedPct,
      osha_dose_pct: o.dosePct,
      osha_twa: fin(o.twa),
      osha_projected_pct: o.projectedPct,
      LAeq_Te: fin(eu.laeqTe),
      LEX_8h: fin(eu.lex8h),
      LCpeak_max: fin(eu.lcpeakMax),
    };
    const checks = Object.entries(c.expected).map(([k, e]) => {
      const g = values[k];
      const ok = e === null || g === null ? e === g : Math.abs(g - e) <= (c.tol[k] ?? 0.005) + 1e-9;
      return { what: k, ok, detail: `${g} (expected ${e})` };
    });
    return { id: c.id, name: c.name, status: c.status, values, checks };
  });
}
