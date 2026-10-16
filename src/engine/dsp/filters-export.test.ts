/**
 * @jest-environment node
 */
// Exports the engine's weighting coefficients for the Python oracle (oracle/weighting_oracle.py) and guards that the
// committed export is not stale: if the filter design changes, this test fails until `npm run oracle` re-exports and the
// oracle is re-run. Writes only with ORACLE_EXPORT=1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { designWeighting } from './weighting';

const FILE = join(__dirname, '../../../oracle/data/engine-filters.json');

function exportFilters() {
  const out: Record<string, Record<string, { gain: number; sections: number[][] }>> = {};
  for (const fs of [44100, 48000]) {
    out[String(fs)] = {};
    for (const w of ['A', 'C'] as const) {
      const c = designWeighting(w, fs);
      out[String(fs)][w] = { gain: c.gain, sections: c.sections.map((s) => [s.b0, s.b1, s.b2, s.a1, s.a2]) };
    }
  }
  return { generatedBy: 'src/engine/dsp/filters-export.test.ts', form: 'H(z) = gain · Π (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)', filters: out };
}

describe('filter export for the Python oracle', () => {
  it('oracle/data/engine-filters.json matches the current design', () => {
    const current = exportFilters();
    if (process.env.ORACLE_EXPORT === '1') writeFileSync(FILE, JSON.stringify(current, null, 2) + '\n');
    expect(existsSync(FILE)).toBe(true);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(current);
  });
});
