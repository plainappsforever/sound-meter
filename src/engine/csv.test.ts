/**
 * @jest-environment node
 */
import { FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL } from './dsp/meter';
import { decodeBlock, encodeBlock } from './codec';
import { BOM, eventsCsv, guardText, parseCsv, separator, seriesCsv1min, seriesCsv1s } from './csv';
import type { ReportEventInput } from './report';
import { recordsFromScript, seededRandom } from './signals';

const START = Date.UTC(2026, 9, 24, 23, 59, 0);

function randomSeries() {
  const rnd = seededRandom(3);
  const recs = recordsFromScript(START, Array.from({ length: 180 }, () => ({ seconds: 1, db: Math.round((25 + rnd() * 70) * 10) / 10 })));
  recs[5].flags = FLAG_OVERLOAD;
  recs[6].flags = FLAG_PARTIAL;
  // values pass through the codec first, as they do in the app
  return decodeBlock(START, encodeBlock(recs.slice(0, 60))).concat(decodeBlock(START + 60_000, encodeBlock(recs.slice(60, 120).map((r, i) => ({ ...r, tMs: START + 60_000 + i * 1000 })))));
}

describe('CSV (SPEC §7.9, A13)', () => {
  it.each(['en', 'de'] as const)('1-s series round-trips exactly to 0.1 dB (%s)', (language) => {
    const recs = randomSeries();
    const csv = seriesCsv1s(recs, { language, tzName: 'Europe/Berlin' });
    expect(csv.startsWith(BOM)).toBe(true);
    const rows = parseCsv(csv, separator(language));
    expect(rows[0][0]).toBe(language === 'de' ? 'Zeit' : 'time');
    const body = rows.slice(1);
    expect(body).toHaveLength(recs.length);
    body.forEach((row, i) => {
      const r = recs[i];
      expect(new Date(row[0]).getTime()).toBe(r.tMs);
      const values = row.slice(1, 8).map((v) => Number(v.replace(',', '.')));
      expect(values).toEqual([r.laeq, r.lceq, r.lzeq, r.lafmax, r.lafmin, r.las, r.lcpeak]);
      expect(row[8]).toBe(r.flags & FLAG_OVERLOAD ? '1' : '0');
      expect(row[9]).toBe(r.flags & FLAG_PARTIAL ? '1' : '0');
    });
    if (language === 'de') expect(csv).toMatch(/;\d+,\d;/);
  });

  it('local ISO 8601 times with offset; mic-busy seconds have empty levels', () => {
    const recs = recordsFromScript(START, [{ seconds: 2, db: 40 }]);
    recs[1] = { ...recs[1], laeq: NaN, lceq: NaN, lzeq: NaN, lafmax: NaN, lafmin: NaN, las: NaN, lcpeak: NaN, flags: FLAG_MIC_BUSY };
    const rows = parseCsv(seriesCsv1s(recs, { language: 'en', tzName: 'Europe/Berlin' }), ',');
    expect(rows[1][0]).toBe('2026-10-25T01:59:00+02:00');
    expect(rows[2].slice(1, 8)).toEqual(['', '', '', '', '', '', '']);
  });

  it('1-min rows: energy mean, max, valid and overload seconds', () => {
    const recs = recordsFromScript(START, [
      { seconds: 30, db: 60 },
      { seconds: 30, db: 70, lafmax: 72, flags: FLAG_OVERLOAD },
      { seconds: 10, db: 50 },
    ]);
    const rows = parseCsv(seriesCsv1min(recs, { language: 'en', tzName: 'UTC', startMs: START }), ',');
    expect(rows.slice(1)).toEqual([
      ['2026-10-24T23:59:00+00:00', '67.4', '72.0', '60', '30'],
      ['2026-10-25T00:00:00+00:00', '50.0', '50.0', '10', '0'],
    ]);
  });

  it('review S3: seconds measured inside a gap have no row (mic-busy rows stay); 1-min valid_s counts like the summary', () => {
    const recs = recordsFromScript(START, [{ seconds: 60, db: 40 }, { seconds: 10, db: 70 }, { seconds: 50, db: 40 }]);
    recs[100] = { ...recs[100], laeq: NaN, lceq: NaN, lzeq: NaN, lafmax: NaN, lafmin: NaN, las: NaN, lcpeak: NaN, flags: FLAG_MIC_BUSY };
    const gaps = [
      { startMs: START + 60_000, endMs: START + 70_000, reason: 'route-change' as const }, // headset mic: the 70-dB seconds
      { startMs: START + 100_000, endMs: START + 101_000, reason: 'mic-busy' as const },
    ];
    const rows = parseCsv(seriesCsv1s(recs, { language: 'en', tzName: 'UTC' }, gaps), ',').slice(1);
    expect(rows).toHaveLength(110);
    expect(rows.some((r) => r[1] === '70.0')).toBe(false);
    expect(rows.filter((r) => r[1] === '')).toHaveLength(1);
    const min = parseCsv(seriesCsv1min(recs, { language: 'en', tzName: 'UTC', startMs: START }, gaps), ',').slice(1);
    expect(min.map((r) => [r[1], r[2], r[3]])).toEqual([
      ['40.0', '40.0', '60'],
      ['40.0', '40.0', '49'],
    ]);
  });

  it('D29 (a): the events CSV marks long events and their nested peaks', () => {
    const base = { sessionId: 1, source: 'auto' as const, laeq: 50, lafmax: 60, lcpeak: 70, lceq: 52, lfHint: false, overloadS: 0, category: null, categoryOther: '', note: '', witnesses: '', effect: null, excluded: false };
    const events: ReportEventInput[] = [
      { ...base, id: 1, startMs: START, endMs: START + 3600_000 },
      { ...base, id: 2, startMs: START + 600_000, endMs: START + 603_000 },
      { ...base, id: 3, startMs: START + 4000_000, endMs: START + 4010_000 },
    ];
    const rows = parseCsv(eventsCsv(events, { language: 'en', tzName: 'UTC' }), ',');
    expect(rows[0].slice(-2)).toEqual(['long_event', 'peak_in_long_event']);
    expect(rows.slice(1).map((r) => r.slice(-2))).toEqual([
      ['1', '0'],
      ['0', '1'],
      ['0', '0'],
    ]);
  });

  it('events CSV quotes separators/newlines and guards formula injection in user text', () => {
    const ev: ReportEventInput = {
      id: 1, sessionId: 3, source: 'auto', startMs: START, endMs: START + 75_000, laeq: 49.7, lafmax: 50, lcpeak: 60.2, lceq: 52,
      lfHint: false, overloadS: 0, category: 'other', categoryOther: '=HYPERLINK("x")', note: 'line1\nline2; "quoted"',
      witnesses: '@Anna, Ben', effect: 'woke', excluded: false,
    };
    const csv = eventsCsv([ev], { language: 'de', tzName: 'Europe/Berlin', sessionTitles: new Map([[3, '+Nacht 1']]) });
    const rows = parseCsv(csv, ';');
    expect(rows).toHaveLength(2);
    const r = rows[1];
    expect(r[0]).toBe("'+Nacht 1");
    expect(r[4]).toBe('\'=HYPERLINK("x")');
    expect(r[5]).toBe('49,7');
    expect(r[3]).toBe('75');
    expect(r[13]).toBe('line1\nline2; "quoted"');
    expect(r[12]).toBe("'@Anna, Ben");
    expect(guardText('-1')).toBe("'-1");
    expect(guardText('plain')).toBe('plain');
  });
});
