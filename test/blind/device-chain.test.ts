/**
 * @jest-environment node
 */
// P3 device chain (opt-in): DEVICE_LOG=<Metro log with "SELFTEST {step:'inject',…}" lines> npx jest test/blind/device-chain
// The dev self-test injected blind set 1's PCM fixtures into the NATIVE ring buffer on a simulator/emulator, received
// them back through push delivery and ran the engine on Hermes; it logged only the per-second levels (never PCM).
// Here, in Node: (1) parity — the same engine on the WAV file must give the same records (Hermes vs V8, transfer
// lossless); (2) the blind set's own expectations on every stored quantity (quantities that need the sample-by-sample
// live taps — LZF max/min, LASmax, burst Δ AS/ZF — are measured only in Node by test/blind and skipped here).
// The blind set was measured once on 695ce45 (V1_LOG); this is a device-path check, not new blind evidence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SecondRecord } from '../../src/engine/dsp/meter';

import { judge, measure, NOT_PRODUCED, readWav, runSignal, type SignalFixture, type SignalRun } from './adapter';

const LOG = process.env.DEVICE_LOG;
const DIR = join(__dirname, 'set-1');
const NEEDS_TAPS = new Set(['LZFmax_1s', 'LZFmin_1s', 'LASmax', 'burst_delta_AS', 'burst_delta_ZF']);
const LEVELS: (keyof SecondRecord)[] = ['laeq', 'lceq', 'lzeq', 'lafmax', 'lafmin', 'las', 'lcpeak'];

type Line = { step: string; platform: string; id: string; fs: number; mismatches: number; frames: number; records: SecondRecord[]; skipped?: string };

function lines(): Line[] {
  const out: Line[] = [];
  for (const l of readFileSync(LOG!, 'utf8').split('\n')) {
    const i = l.indexOf('SELFTEST {');
    if (i < 0) continue;
    const j = JSON.parse(l.slice(i + 9)) as Line;
    if (j.step === 'inject' && !j.skipped) out.push(j);
  }
  // last run per platform + fixture
  const last = new Map<string, Line>();
  for (const j of out) last.set(`${j.platform} ${j.id}`, j);
  return [...last.values()];
}

const shift = (r: SecondRecord, o: number): SecondRecord => {
  const c = { ...r };
  for (const k of LEVELS) (c[k] as number) = (r[k] as number) + o;
  return c;
};

(LOG ? describe : describe.skip)('P3 device chain: injected blind fixtures through the native module', () => {
  const fixtures = (JSON.parse(readFileSync(join(DIR, 'expected/signals.json'), 'utf8')) as { fixtures: SignalFixture[] }).fixtures;
  const summary: string[] = [];

  afterAll(() => summary.length && console.log(summary.join('\n')));
  if (!LOG) it('needs DEVICE_LOG', () => {});

  for (const dev of LOG ? lines() : []) {
    it(`${dev.platform} ${dev.id}: sample-exact transfer, parity with Node, blind expectations`, () => {
      const fx = fixtures.find((f) => f.id === dev.id)!;
      const { fs, x } = readWav(join(DIR, fx.file));
      expect(dev.mismatches).toBe(0);
      expect(dev.frames).toBe(x.length);
      // (1) parity with the Node engine on the file
      const node = runSignal(x, fs, 0).records;
      let maxDiff = 0;
      for (const r of dev.records) {
        const n = node[r.tMs];
        expect(n).toBeDefined();
        expect(r.flags).toBe(n!.flags);
        for (const k of LEVELS) {
          const a = r[k] as number | null;
          const b = n![k] as number;
          if (a === null || !Number.isFinite(b)) expect([k, a === null]).toEqual([k, !Number.isFinite(b)]);
          else maxDiff = Math.max(maxDiff, Math.abs(a - b));
        }
      }
      expect(maxDiff).toBeLessThan(1e-6);
      // (2) blind expectations on stored quantities
      let pass = 0;
      let fail = 0;
      let skipped = 0;
      for (const a of fx.assertions) {
        if (NOT_PRODUCED.has(a.quantity) || NEEDS_TAPS.has(a.quantity)) {
          skipped++;
          continue;
        }
        const records: (SecondRecord | undefined)[] = [];
        for (const r of dev.records) records[r.tMs] = shift({ ...r, laeq: r.laeq ?? NaN, lceq: r.lceq ?? NaN, lzeq: r.lzeq ?? NaN, lafmax: r.lafmax ?? NaN, lafmin: r.lafmin ?? NaN, las: r.las ?? NaN, lcpeak: r.lcpeak ?? NaN }, a.offset_db ?? 0);
        const run: SignalRun = { records, taps: [] };
        const ok = judge(a, measure(run, a));
        if (a.info_only) continue;
        if (ok) pass++;
        else fail++;
      }
      summary.push(`${dev.platform} ${dev.id} fs ${fs}: transfer exact (${dev.frames} frames), max |device − Node| ${maxDiff.toExponential(1)} dB, blind ${pass} pass / ${fail} fail / ${skipped} live-tap or not-produced skipped`);
      expect(fail).toBe(0);
    });
  }
});
