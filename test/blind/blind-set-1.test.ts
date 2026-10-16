/**
 * @jest-environment node
 */
// Blind set 1 (test/blind/set-1, written by a separate agent; WORKFLOW L27). Runs only with BLIND=1 (`npm run blind`):
// it reads 108 MB of fixtures and feeds every PCM file twice through the meter (~1 min).
// Writes test/blind/results/<BLIND_LABEL>-engine-output.json (engine values next to the expectations) and
// <BLIND_LABEL>-summary.txt. The first run, on the engine snapshot 695ce45, is the evidence (docs/V1_LOG.md); after the
// fix round the set is a TUNING set — its figures are no longer blind evidence.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDose, runNights, runSignals } from './adapter';

const DIR = join(__dirname, 'set-1');
const OUT = join(__dirname, 'results');
const run = process.env.BLIND === '1' ? describe : describe.skip;

run('blind set 1', () => {
  it('runs the engine over signals, nights and dose and writes the results', () => {
    const label = process.env.BLIND_LABEL ?? 'latest';
    const signals = runSignals(DIR);
    const nights = runNights(DIR);
    const doses = runDose(DIR);
    const lines: string[] = [`Blind set 1 — engine run "${label}"`, ''];

    const count = (o: string) => signals.reduce((s, f) => s + f.assertions.filter((a) => a.outcome === o).length, 0);
    const total = signals.reduce((s, f) => s + f.assertions.length, 0);
    lines.push(
      `SIGNALS: ${total} assertions — gated ${count('pass') + count('fail')}: pass ${count('pass')}, fail ${count('fail')}; ` +
        `info-only ${count('info-pass') + count('info-fail')} (pass ${count('info-pass')}, outside ${count('info-fail')}); ` +
        `not produced by the engine ${count('not-produced')}`
    );
    for (const f of signals) {
      const fails = f.assertions.filter((a) => a.outcome === 'fail');
      const np = f.assertions.filter((a) => a.outcome === 'not-produced').length;
      const gated = f.assertions.filter((a) => a.outcome === 'pass' || a.outcome === 'fail').length;
      lines.push(`  ${f.id} ${f.name.padEnd(36)} ${fails.length ? 'FAIL' : 'ok  '} ${gated - fails.length}/${gated}${np ? ` (n/p ${np})` : ''}`);
      for (const a of fails)
        lines.push(
          `      ${a.quantity}[${a.second ?? (a.range ? a.range.join('-') : 'all')}] expected ${a.expected} ` +
            `(${a.lo !== undefined ? `lo ${a.lo} hi ${a.hi}` : `tol ${a.tol}`}) engine ${a.measured === null ? 'no value' : a.measured.toFixed(4)} ` +
            `[${a.status}${a.initial_state_assumption ? ', y[-1]=0 assumption' : ''}${a.spec_weakness ? ', spec weakness' : ''}]`
        );
    }

    const nChecks = nights.flatMap((n) => n.checks);
    lines.push('', `NIGHTS: ${nights.filter((n) => n.checks.every((c) => c.ok)).length}/${nights.length} nights fully right; checks ${nChecks.filter((c) => c.ok).length}/${nChecks.length} pass`);
    for (const n of nights) {
      const bad = n.checks.filter((c) => !c.ok);
      const counts = Object.entries(n.events).map(([d, e]) => `Δ${d}: ${e.length}`).join(', ');
      lines.push(`  ${n.id} ${n.name.padEnd(36)} ${bad.length ? 'FAIL' : 'ok  '} ${counts}${n.variantMatch ? ` · matches reading(s): ${n.variantMatch.join(', ') || 'none of the 8'}` : ''}`);
      for (const c of bad) lines.push(`      ${c.what}: ${c.detail}`);
      if (n.variantMatch) lines.push(`      engine events: ${JSON.stringify(n.events[String(10)].map((e) => [e.start_s, e.end_s]))}`);
    }

    const dChecks = doses.flatMap((d) => d.checks);
    lines.push('', `DOSE: ${doses.filter((d) => d.checks.every((c) => c.ok)).length}/${doses.length} cases fully right; values ${dChecks.filter((c) => c.ok).length}/${dChecks.length} pass`);
    for (const d of doses) {
      const bad = d.checks.filter((c) => !c.ok);
      lines.push(`  ${d.id} ${d.name.padEnd(36)} ${bad.length ? 'FAIL' : 'ok  '}`);
      for (const c of bad) lines.push(`      ${c.what}: ${c.detail}`);
    }

    writeFileSync(join(OUT, `${label}-engine-output.json`), JSON.stringify({ label, signals, nights, dose: doses }, null, 1) + '\n');
    writeFileSync(join(OUT, `${label}-summary.txt`), lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    expect(signals.length).toBe(46);
    expect(nights.length).toBe(20);
    expect(doses.length).toBe(13);
  });
});
