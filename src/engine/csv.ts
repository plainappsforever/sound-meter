// CSV exports (SPEC §7.9, docs/FORMATS.md): the 1-s or 1-min series of a session and the events of a session or case.
// German: ';' separator and decimal comma; English: ',' and point. Times are ISO 8601 local time with offset.
// User text is guarded against spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) gets a leading '.
// A UTF-8 byte-order mark is prepended so spreadsheet apps read umlauts correctly.
import { formatNumber, translate, type Language, type MessageKey } from '@/i18n/translate';

import { FLAG_MIC_BUSY, FLAG_OVERLOAD, FLAG_PARTIAL, type SecondRecord } from './dsp/meter';
import { nestedPeaks } from './events';
import { energyMean, gapLookup, isValid, type Gap } from './levels';
import { isLongEvent, type ReportEventInput } from './report';
import { isoLocal } from './time';

export const BOM = '﻿';

export type CsvOptions = { language: Language; tzName: string };

export function separator(language: Language): string {
  return language === 'de' ? ';' : ',';
}

/** Formula-injection guard for user-written text cells. */
export function guardText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cell(v: string, sep: string): string {
  return /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v;
}

function rowsToCsv(rows: string[][], language: Language): string {
  const sep = separator(language);
  return BOM + rows.map((r) => r.map((c) => cell(c, sep)).join(sep)).join('\r\n') + '\r\n';
}

const num = (language: Language, v: number) => (Number.isFinite(v) ? formatNumber(language, v, 1) : '');

/**
 * 1-s rows: one per stored second. Missing seconds and seconds measured inside a gap (headset mic, interruption…)
 * have no row (review S3: what the summary and events exclude is not exported as normal data); mic-busy seconds keep
 * their row with empty levels — they are the record of the mic-busy gap.
 */
export function seriesCsv1s(records: readonly SecondRecord[], o: CsvOptions, gaps: readonly Gap[] = []): string {
  const t = (k: MessageKey) => translate(o.language, k);
  const head = ['csv.time', 'csv.laeq', 'csv.lceq', 'csv.lzeq', 'csv.lafmax', 'csv.lafmin', 'csv.las', 'csv.lcpeak', 'csv.overload', 'csv.partial'] as const;
  const rows = [head.map(t)];
  const inGap = gapLookup(gaps);
  for (const r of [...records].sort((a, b) => a.tMs - b.tMs)) {
    if (inGap(r.tMs) && !(r.flags & FLAG_MIC_BUSY)) continue;
    rows.push([
      isoLocal(r.tMs, o.tzName),
      num(o.language, r.laeq),
      num(o.language, r.lceq),
      num(o.language, r.lzeq),
      num(o.language, r.lafmax),
      num(o.language, r.lafmin),
      num(o.language, r.las),
      num(o.language, r.lcpeak),
      r.flags & FLAG_OVERLOAD ? '1' : '0',
      r.flags & FLAG_PARTIAL ? '1' : '0',
    ]);
  }
  return rowsToCsv(rows, o.language);
}

/**
 * 1-min rows: energy mean of the valid seconds, max LAFmax, valid and overloaded seconds per minute. Valid = as in the
 * summary: not mic-busy and not inside a gap (review S3).
 */
export function seriesCsv1min(records: readonly SecondRecord[], o: CsvOptions & { startMs: number }, gaps: readonly Gap[] = []): string {
  const inGap = gapLookup(gaps);
  const t = (k: MessageKey) => translate(o.language, k);
  const rows = [[t('csv.time'), t('csv.laeqMin'), t('csv.lafmax'), t('csv.validS'), t('csv.overloadS')]];
  const byMinute = new Map<number, SecondRecord[]>();
  for (const r of records) {
    const m = o.startMs + Math.floor((r.tMs - o.startMs) / 60_000) * 60_000;
    const list = byMinute.get(m);
    if (list) list.push(r);
    else byMinute.set(m, [r]);
  }
  for (const [m, recs] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) {
    const valid = recs.filter((r) => isValid(r) && !inGap(r.tMs));
    rows.push([
      isoLocal(m, o.tzName),
      num(o.language, energyMean(valid.map((r) => r.laeq))),
      num(o.language, valid.reduce((x, r) => (r.lafmax > x ? r.lafmax : x), valid.length ? -Infinity : NaN)),
      String(valid.length),
      String(valid.filter((r) => r.flags & FLAG_OVERLOAD).length),
    ]);
  }
  return rowsToCsv(rows, o.language);
}

/** Events of a session or case; `sessionTitles` adds the session column for case exports. */
export function eventsCsv(events: readonly ReportEventInput[], o: CsvOptions & { sessionTitles?: Map<number, string> }): string {
  const t = (k: MessageKey) => translate(o.language, k);
  const head = [
    ...(o.sessionTitles ? [t('csv.session')] : []),
    t('csv.start'),
    t('csv.end'),
    t('csv.durationS'),
    t('csv.kind'),
    t('csv.laeq').replace('_1s', ''),
    t('csv.lafmax'),
    t('csv.lcpeak'),
    t('csv.lceq').replace('_1s', ''),
    t('csv.lfHint'),
    t('csv.overloadS'),
    t('csv.effect'),
    t('csv.witnesses'),
    t('csv.note'),
    t('csv.source'),
    t('csv.excluded'),
    t('csv.longEvent'),
    t('csv.nestedPeak'),
  ];
  const rows = [head];
  const nested = nestedPeaks(events);
  const n = (v: number | null) => (v === null ? '' : num(o.language, v));
  for (const e of [...events].sort((a, b) => a.startMs - b.startMs))
    rows.push([
      ...(o.sessionTitles ? [guardText(e.sessionId !== null ? (o.sessionTitles.get(e.sessionId) ?? '') : '')] : []),
      isoLocal(e.startMs, o.tzName),
      isoLocal(e.endMs, o.tzName),
      String(Math.round((e.endMs - e.startMs) / 1000)),
      e.category === 'other' && e.categoryOther ? guardText(e.categoryOther) : (e.category ?? ''),
      n(e.laeq),
      n(e.lafmax),
      n(e.lcpeak),
      n(e.lceq),
      e.lfHint === null ? '' : e.lfHint ? '1' : '0',
      String(e.overloadS),
      e.effect ?? '',
      guardText(e.witnesses),
      guardText(e.note),
      e.source,
      e.excluded ? '1' : '0',
      isLongEvent(e) && !nested.has(e.id) ? '1' : '0',
      nested.has(e.id) ? '1' : '0',
    ]);
  return rowsToCsv(rows, o.language);
}

/** Minimal RFC 4180 parser (tests and future import); strips the BOM. */
export function parseCsv(text: string, sep: string): string[][] {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
