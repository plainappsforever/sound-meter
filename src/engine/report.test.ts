/**
 * @jest-environment node
 */
import { newSession } from '../../test/fixtures';
import { FLAG_OVERLOAD } from './dsp/meter';
import { detectEvents } from './events';
import { buildReport, calibrationState, chartMinutes, type ReportEventInput } from './report';
import { escapeHtml, renderReportHtml } from './report-html';
import { recordsFromScript } from './signals';

const START = Date.UTC(2026, 9, 24, 20, 0, 0); // 22:00 CEST, the night of the clock change

function nightInput(over: Partial<ReturnType<typeof newSession>> = {}) {
  const session = { id: 7, endedAt: null as number | null, ...newSession({ startedAt: START, ...over }) };
  const records = recordsFromScript(START, [
    { seconds: 900, db: 30 },
    { seconds: 60, db: 50 },
    { seconds: 5, db: 30 },
    { seconds: 10, db: 50 },
    { seconds: 3600 * 2, db: 30 },
    { seconds: 600, db: null }, // gap
    { seconds: 3600 * 3, db: 31 },
    { seconds: 30, db: 70, lc: 85, flags: FLAG_OVERLOAD },
    { seconds: 900, db: 30 },
  ]);
  session.endedAt = records[records.length - 1].tMs + 1000;
  const gaps = [{ startMs: START + 975_000 + 7_200_000, endMs: START + 975_000 + 7_800_000, reason: 'interruption' as const }];
  const events: ReportEventInput[] = detectEvents(records, gaps, { sensitivity: 'normal' }).map((c, i) => ({
    id: i + 1,
    sessionId: 7,
    source: 'auto',
    startMs: c.startMs,
    endMs: c.endMs,
    laeq: c.laeq,
    lafmax: c.lafmax,
    lcpeak: c.lcpeak,
    lceq: c.lceq,
    lfHint: c.lfHint,
    overloadS: c.overloadS,
    category: i === 0 ? 'music' : null,
    categoryOther: '',
    note: i === 0 ? '<script>alert(1)</script> bass' : '',
    witnesses: i === 0 ? 'Anna & Ben' : '',
    effect: i === 0 ? 'woke' : null,
    excluded: false,
  }));
  return { session, records, gaps, events };
}

describe('report model (SPEC §7.8)', () => {
  it('summarises a night: events, events 22–06, background, gaps, DST change, chart minutes', () => {
    const n = nightInput();
    const m = buildReport({ kind: 'night', nights: [n], generatedAt: START });
    const night = m.nights[0];
    expect(night.events).toHaveLength(2);
    expect(night.events2206).toBe(2);
    expect(night.backgroundDb).toBe(30);
    expect(night.summary.overloadS).toBe(30);
    expect(m.overloadS).toBe(30);
    expect(night.offsetChanges).toEqual([{ atMs: Date.UTC(2026, 9, 25, 1, 0), fromMin: 120, toMin: 60 }]);
    expect([night.startOffsetMin, night.endOffsetMin]).toEqual([120, 60]);
    expect(night.chart.some((c) => c.laeq === null)).toBe(true); // the gap minutes
    expect(night.calibration.kind).toBe('factory-nominal');
  });

  it('review S3/S2: chart minutes inside a gap are blank even if seconds were measured; gap total = union in the span', () => {
    const recs = recordsFromScript(START, [{ seconds: 600, db: 30 }, { seconds: 120, db: 60 }, { seconds: 600, db: 30 }]);
    const gaps = [
      { startMs: START + 600_000, endMs: START + 720_000, reason: 'route-change' as const },
      { startMs: START + 660_000, endMs: START + 720_000, reason: 'paused' as const },
      { startMs: START + 2_000_000, endMs: START + 2_100_000, reason: 'app-killed' as const }, // after the end: not counted
    ];
    const chart = chartMinutes(recs, START, START + 1_320_000, gaps);
    expect(chart.slice(10, 12).map((c) => c.laeq)).toEqual([null, null]);
    expect(chart.some((c) => c.laeq !== null && c.laeq > 40)).toBe(false);
    const session = { id: 9, endedAt: START + 1_320_000, ...newSession({ startedAt: START }) };
    const m = buildReport({ kind: 'night', nights: [{ session, records: recs, gaps, events: [] }], generatedAt: START });
    expect(m.nights[0].summary.gapMs).toBe(120_000);
  });

  it('D29 (a): a long event with a nested peak — listed under it, labelled, counted once', () => {
    const recs = recordsFromScript(START, [{ seconds: 900, db: 30 }, { seconds: 3600, db: 42 }, { seconds: 3, db: 42, lafmax: 62 }, { seconds: 3600, db: 42 }, { seconds: 600, db: 30 }]);
    const session = { id: 3, endedAt: recs[recs.length - 1].tMs + 1000, ...newSession({ startedAt: START }) };
    const flat = detectEvents(recs, [], { sensitivity: 'normal' }).flatMap((c) => [c, ...c.peaks]);
    const events: ReportEventInput[] = flat.map((c, i) => ({
      id: i + 1, sessionId: 3, source: 'auto', startMs: c.startMs, endMs: c.endMs, laeq: c.laeq, lafmax: c.lafmax, lcpeak: c.lcpeak, lceq: c.lceq,
      lfHint: c.lfHint, overloadS: c.overloadS, category: null, categoryOther: '', note: '', witnesses: '', effect: null, excluded: false,
    }));
    const m = buildReport({ kind: 'night', nights: [{ session, records: recs, gaps: [], events }], generatedAt: START });
    expect(m.nights[0].events).toHaveLength(2);
    expect(m.nights[0].eventCount).toBe(1);
    expect(m.nights[0].events2206).toBe(1);
    expect(m.nights[0].peakOf).toEqual({ 2: 1 });
    const html = renderReportHtml(m, { language: 'en', locale: 'en-GB' });
    expect(html).toContain('long event · ');
    expect(html).toContain('↳ peak inside the long event · ');
  });

  it('excluded events are listed separately and not counted', () => {
    const n = nightInput();
    n.events[1].excluded = true;
    const night = buildReport({ kind: 'night', nights: [n], generatedAt: START }).nights[0];
    expect(night.events).toHaveLength(1);
    expect(night.excluded).toHaveLength(1);
  });

  it('calibration states: reference meter, manual, factory nominal (UNPROCESSED), placeholder (others)', () => {
    const base = { offsetDb: 130, calibratedAt: 1, referenceMeter: 'UT353', audioSource: 'unprocessed' as const };
    expect(calibrationState({ ...base, calibMethod: 'reference-meter' }).kind).toBe('calibrated');
    expect(calibrationState({ ...base, calibMethod: 'manual-entry' }).kind).toBe('manual');
    expect(calibrationState({ ...base, calibMethod: 'platform-default' }).kind).toBe('factory-nominal');
    expect(calibrationState({ ...base, calibMethod: 'platform-default', audioSource: 'ios_measurement' }).kind).toBe('placeholder');
  });

  it('chart minutes: energy mean and max per minute, null without data', () => {
    const recs = recordsFromScript(0, [
      { seconds: 30, db: 60 },
      { seconds: 30, db: 70, lafmax: 75 },
      { seconds: 60, db: null },
    ]);
    const c = chartMinutes(recs, 0, 120_000);
    expect(c[0].laeq).toBeCloseTo(67.4, 1);
    expect(c[0].lmax).toBe(75);
    expect(c[1]).toEqual({ tMs: 60_000, laeq: null, lmax: null });
  });
});

describe('report HTML (A13)', () => {
  it('contains the cover box, calibration state, audio source, gaps, event table, references and footer (EN)', () => {
    const html = renderReportHtml(buildReport({ kind: 'night', nights: [nightInput()], generatedAt: START }), { language: 'en', locale: 'en-GB' });
    expect(html).toContain('id="report-cover"');
    expect(html).toContain('Noise protocol with measured levels (phone estimate)');
    expect(html).toContain('Factory nominal — not calibrated');
    expect(html).toContain('Unprocessed microphone · 48000 Hz');
    expect(html).toContain('Interrupted (call or another app)');
    expect(html).toContain('class="events"');
    expect(html).toContain('Music / bass');
    expect(html).toContain('Woke me up');
    expect(html).toContain('WHO 1999, bedroom at night');
    expect(html).toContain('TA Lärm');
    expect(html).toContain('Phone estimate · not a calibrated sound level meter');
    expect(html).toContain('counter(page)');
    expect(html).toContain('The clock changed during this period: UTC+02:00 → UTC+01:00.');
    expect(html).toContain('Times are local time (Europe/Berlin).');
    expect(html).toContain('30 s at the microphone limit');
    expect(html).toContain('≥ 70.0'); // overloaded event values are lower bounds
    expect(html).toContain('<svg');
  });

  it('escapes user text (no script injection) and formats German numbers with a decimal comma', () => {
    const html = renderReportHtml(buildReport({ kind: 'night', nights: [nightInput()], generatedAt: START }), { language: 'de', locale: 'de-DE' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; bass');
    expect(html).toContain('Anna &amp; Ben');
    expect(html).toContain('Lärmprotokoll mit Messwerten (Schätzung per Smartphone)');
    expect(html).toContain('49,7');
    expect(html).toContain('Werks-Nennwert — nicht kalibriert');
    expect(html).toContain('lang="de"');
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });

  it('case report: several nights, manual entries "noted, not measured", calibrated state with the meter name', () => {
    const a = nightInput({ calibMethod: 'reference-meter', calibratedAt: Date.UTC(2026, 9, 12), referenceMeter: 'UNI-T UT353' });
    const b = nightInput();
    b.session.id = 8;
    const manual: ReportEventInput = {
      id: 99,
      sessionId: null,
      source: 'manual',
      startMs: Date.UTC(2026, 9, 26, 21),
      endMs: Date.UTC(2026, 9, 26, 22),
      laeq: null,
      lafmax: null,
      lcpeak: null,
      lceq: null,
      lfHint: null,
      overloadS: 0,
      category: 'footsteps',
      categoryOther: '',
      note: 'stomping',
      witnesses: '',
      effect: 'kept-awake',
      excluded: false,
    };
    const m = buildReport({ kind: 'case', caseInfo: { name: 'Flat above', address: 'Main St 1', notes: '' }, nights: [a, b], manualEntries: [manual], generatedAt: START });
    const html = renderReportHtml(m, { language: 'en', locale: 'en-GB' });
    expect(html).toContain('Flat above');
    expect(html).toContain('Main St 1');
    expect(html).toContain('Calibrated 12/10/2026 against UNI-T UT353');
    expect(html).toContain('Noted, not measured');
    expect(html).toContain('Footsteps / impact');
    expect((html.match(/class="night"/g) ?? []).length).toBe(2);
    expect(m.periodEndMs).toBe(manual.endMs);
  });

  it('a night without data says so and draws an empty chart', () => {
    const session = { id: 1, endedAt: START + 60_000, ...newSession({ startedAt: START }) };
    const html = renderReportHtml(buildReport({ kind: 'night', nights: [{ session, records: [], gaps: [], events: [] }], generatedAt: START }), {
      language: 'en',
      locale: 'en-GB',
    });
    expect(html).toContain('No measured data.');
    expect(html).toContain('No events.');
  });
});
