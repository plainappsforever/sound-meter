/**
 * @jest-environment node
 */
// Runner for the in-repo Python oracle (oracle/levels_oracle.py → oracle/expectations/levels.json). It synthesises
// PCM / 1-s records from the DESCRIPTIONS only and compares the engine with the oracle's expectations.
// Independence: the oracle is Python stdlib, derives the IEC poles from the standard's equations and never reads the
// engine; but it was written by the same agent that built the engine (not blind, L27) — the blind set is P2.5's job.
// The weighting-filter oracle (class-2 tolerance table) is oracle/weighting_oracle.py, run by `npm run oracle`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dose } from './dose';
import { createMeter, type SecondRecord } from './dsp/meter';
import { aggregate } from './levels';
import { chunks, multitone, sineAmplitudeForRmsDbfs } from './signals';

type Case =
  | { kind: 'sine'; id: string; fs: number; f: number; rmsDbfs: number; seconds: number; offsetDb: number; expect: Record<'lzeq' | 'laeq' | 'lceq', number>; tolDb: number }
  | { kind: 'multitone'; id: string; fs: number; tones: { f: number; amplitude: number; phase: number }[]; seconds: number; offsetDb: number; expect: Record<'lzeq' | 'laeq' | 'lceq', number>; tolDb: number }
  | { kind: 'pcm_steps'; id: string; fs: number; f: number; offsetDb: number; steps: { seconds: number; db: number }[]; expect: { laeq: number; nioshPct: number }; tolDb: number; tolPct: number }
  | {
      kind: 'script';
      id: string;
      segments: { seconds: number; db: number; jitter: boolean }[];
      expect: Record<'laeq' | 'l10' | 'l50' | 'l90' | 'nioshPct' | 'nioshProjectedPct' | 'oshaPct' | 'lex8h', number> & { nioshTwa: number | null; oshaTwa: number | null };
      tolDb: number;
      tolPct: number;
    };

const file = JSON.parse(readFileSync(join(__dirname, '../../oracle/expectations/levels.json'), 'utf8')) as { cases: Case[] };
const byKind = <K extends Case['kind']>(k: K) => file.cases.filter((c): c is Extract<Case, { kind: K }> => c.kind === k);

function meterRecords(pcm: Float32Array, fs: number, offsetDb: number): SecondRecord[] {
  const meter = createMeter({ fs, offsetDb });
  let t = 0;
  for (const c of chunks(pcm, Math.round(fs / 10))) {
    meter.process(c, t);
    t += (c.length * 1000) / fs;
  }
  return meter.drainSeconds();
}

const energy = (recs: SecondRecord[], k: 'laeq' | 'lceq' | 'lzeq') => 10 * Math.log10(recs.reduce((s, r) => s + 10 ** (r[k] / 10), 0) / recs.length);

const round1 = (v: number) => (Math.sign(v) * Math.floor(Math.abs(v) * 10 + 0.5)) / 10;

const mismatches: string[] = [];
let maxDevDb = 0;
const maxByKind: Record<string, number> = {};
function check(id: string, name: string, got: number | null, want: number | null, tol: number) {
  if (want === null || got === null || !Number.isFinite(got)) {
    if (!(want === null && (got === null || !Number.isFinite(got as number)))) mismatches.push(`${id} ${name}: got ${got}, want ${want}`);
    return;
  }
  const d = Math.abs(got - want);
  const kind = `${id.split('-')[0]}:${/Pct$/.test(name) ? '%' : 'dB'}`;
  maxByKind[kind] = Math.max(maxByKind[kind] ?? 0, d);
  if (!/Pct$/.test(name)) maxDevDb = Math.max(maxDevDb, d);
  if (d > tol) mismatches.push(`${id} ${name}: got ${got.toFixed(4)}, want ${want.toFixed(4)} (|Δ| ${d.toFixed(4)} > ${tol})`);
}

describe('in-repo oracle (Python, not blind) — measured once against the engine snapshot 695ce45', () => {
  it('has the expected case set', () => {
    expect(byKind('sine').length).toBe(56);
    expect(byKind('multitone').length).toBe(6);
    expect(byKind('pcm_steps').length).toBe(6);
    expect(byKind('script').length).toBe(120);
  });

  it('sines at exact third-octave frequencies: LZ/LA/LC within the A1 tolerance of the oracle', () => {
    for (const c of byKind('sine')) {
      const recs = meterRecords(multitone(c.fs, [{ f: c.f, amplitude: sineAmplitudeForRmsDbfs(c.rmsDbfs) }], c.seconds), c.fs, c.offsetDb).slice(1);
      for (const k of ['lzeq', 'laeq', 'lceq'] as const) check(c.id, k, energy(recs, k), c.expect[k], c.tolDb);
    }
  });

  it('pink multitones: LA, LC within 0.1 dB (A1)', () => {
    for (const c of byKind('multitone')) {
      const recs = meterRecords(multitone(c.fs, c.tones, c.seconds), c.fs, c.offsetDb).slice(1);
      for (const k of ['lzeq', 'laeq', 'lceq'] as const) check(c.id, k, energy(recs, k), c.expect[k], c.tolDb);
    }
  });

  it('PCM steps: session LAeq and NIOSH dose from PCM', () => {
    for (const c of byKind('pcm_steps')) {
      const total = c.steps.reduce((s, x) => s + x.seconds, 0);
      const pcm = new Float32Array(total * c.fs);
      let pos = 0;
      for (const s of c.steps) {
        const amp = sineAmplitudeForRmsDbfs(s.db - c.offsetDb);
        for (let i = 0; i < s.seconds * c.fs; i++, pos++) pcm[pos] = amp * Math.sin((2 * Math.PI * c.f * pos) / c.fs);
      }
      const recs = meterRecords(pcm, c.fs, c.offsetDb);
      check(c.id, 'laeq', aggregate(recs).laeq, c.expect.laeq, c.tolDb);
      check(c.id, 'nioshPct', dose(recs, 'niosh').dosePct, c.expect.nioshPct, c.tolPct);
    }
  });

  it('record scripts: LAeq, L10/L50/L90, NIOSH/OSHA dose + TWA + projected, LEX,8h', () => {
    for (const c of byKind('script')) {
      const recs: SecondRecord[] = [];
      let t = 0;
      for (const s of c.segments)
        for (let i = 0; i < s.seconds; i++, t += 1000) {
          const v = s.jitter ? round1(s.db + (((i * 7) % 19) - 9) / 10) : s.db;
          recs.push({ tMs: t, laeq: v, lceq: v, lzeq: v, lafmax: v, lafmin: v, las: v, lcpeak: v, flags: 0 });
        }
      const sum = aggregate(recs);
      const n = dose(recs, 'niosh');
      const o = dose(recs, 'osha');
      check(c.id, 'laeq', sum.laeq, c.expect.laeq, c.tolDb);
      check(c.id, 'l10', sum.l10, c.expect.l10, c.tolDb);
      check(c.id, 'l50', sum.l50, c.expect.l50, c.tolDb);
      check(c.id, 'l90', sum.l90, c.expect.l90, c.tolDb);
      check(c.id, 'nioshPct', n.dosePct, c.expect.nioshPct, c.tolPct);
      check(c.id, 'nioshTwa', Number.isFinite(n.twa) ? n.twa : null, c.expect.nioshTwa, c.tolDb);
      check(c.id, 'nioshProjectedPct', n.projectedPct, c.expect.nioshProjectedPct, Math.max(c.tolPct, 1e-6 * c.expect.nioshProjectedPct));
      check(c.id, 'oshaPct', o.dosePct, c.expect.oshaPct, c.tolPct);
      check(c.id, 'oshaTwa', Number.isFinite(o.twa) ? o.twa : null, c.expect.oshaTwa, c.tolDb);
      check(c.id, 'lex8h', dose(recs, 'eu').lex8h, c.expect.lex8h, c.tolDb);
    }
  });

  afterAll(() => {
    if (process.env.PRINT_TABLES)
      console.log(`oracle: ${mismatches.length} mismatches; max level deviation ${maxDevDb.toFixed(4)} dB; by kind ${JSON.stringify(maxByKind)}`);
  });

  it('0 mismatches', () => {
    expect(mismatches).toEqual([]);
  });
});
