// Report HTML for expo-print (SPEC §7.8, D17): cover box, calibration state, audio source, summary per night, chart
// (inline SVG), gaps, events, excluded events, manual entries, sourced reference values, footer. All user text is
// HTML-escaped. RTL-safe: `dir` on <html>; the chart stays left-to-right (time axis).
// Page numbers use CSS @page margin boxes (counter(page)/counter(pages)), which some print engines ignore — the fixed
// footer with the honesty line is always printed. Rendering in expo-print is measured in P5 (IMPLEMENTED BUT UNVERIFIED).
import { formatNumber, messages, translate, type Language, type MessageKey } from '@/i18n/translate';

import { isLongEvent, type ChartMinute, type NightModel, type ReportEventInput, type ReportModel } from './report';
import { formatDate, formatDuration, formatOffset, formatTime } from './time';

export type RenderOptions = { language: Language; locale: string; dir?: 'ltr' | 'rtl' };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cssString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderReportHtml(model: ReportModel, opts: RenderOptions): string {
  const { language: lang, locale } = opts;
  const t = (k: MessageKey, p?: Record<string, string | number>) => translate(lang, k, p);
  const e = escapeHtml;
  const db = (v: number | null | undefined, lowerBound = false) =>
    v === null || v === undefined || !Number.isFinite(v) ? '–' : `${lowerBound ? '≥ ' : ''}${formatNumber(lang, v)}`;
  const date = (ms: number, tz: string) => formatDate(ms, tz, locale);
  const time = (ms: number, tz: string) => formatTime(ms, tz, locale);
  const dateTime = (ms: number, tz: string) => `${date(ms, tz)} ${time(ms, tz)}`;
  const kind = (ev: ReportEventInput) =>
    ev.category === null
      ? t('kind.none')
      : ev.category === 'other' && ev.categoryOther.trim()
        ? e(ev.categoryOther)
        : isKey(`kind.${ev.category}`)
          ? t(`kind.${ev.category}` as MessageKey)
          : e(ev.category);
  const effect = (ev: ReportEventInput) => (ev.effect && isKey(`effect.${ev.effect}`) ? t(`effect.${ev.effect}` as MessageKey) : '');
  const yesNo = (b: boolean | null) => (b === null ? '–' : b ? t('report.yes') : t('report.no'));

  const calibLine = (n: NightModel) => {
    const c = n.calibration;
    const when = c.calibratedAt !== null ? date(c.calibratedAt, n.tzName) : '';
    const label =
      c.kind === 'calibrated'
        ? t('calib.calibrated', { date: when, meter: e(c.referenceMeter) })
        : c.kind === 'manual'
          ? t('calib.manual', { date: when })
          : c.kind === 'factory-nominal'
            ? t('calib.factoryNominal')
            : t('calib.placeholder');
    return `<span class="chip ${c.kind === 'calibrated' ? 'ok' : 'warn'}">${label}</span> · ${t('report.cover.offset', { offset: formatNumber(lang, c.offsetDb, 2) })}`;
  };

  const first = model.nights[0];
  const tz = model.tzName;
  const period =
    model.periodStartMs !== null && model.periodEndMs !== null
      ? `${dateTime(model.periodStartMs, tz)} – ${dateTime(model.periodEndMs, tz)}`
      : '–';

  const coverRows: [string, string][] = [];
  if (model.caseInfo) {
    coverRows.push([t('report.cover.case'), e(model.caseInfo.name)]);
    if (model.caseInfo.address) coverRows.push([t('report.cover.address'), e(model.caseInfo.address)]);
  }
  coverRows.push([t('report.cover.period'), `${period}<br><small>${t('report.timezone', { zone: e(tz) })}</small>`]);
  if (first) {
    if (first.operator) coverRows.push([t('report.cover.operator'), e(first.operator)]);
    if (model.kind === 'night' && first.place) coverRows.push([t('report.cover.place'), e(first.place)]);
    coverRows.push([t('report.cover.phone'), `${e(first.deviceModel)} · ${e(first.osVersion)}`]);
    coverRows.push([t('report.cover.audioSource'), `${t(`audio.${first.audioSource}` as MessageKey)} · ${first.sampleRate} Hz`]);
    coverRows.push([t('report.cover.calibration'), calibLine(first)]);
    if (first.calibration.referenceMeter)
      coverRows.push([t('report.cover.referenceMeter'), e(first.calibration.referenceMeter)]);
    coverRows.push([t('report.cover.sensitivity'), t(`sens.${first.sensitivity}` as MessageKey)]);
    coverRows.push([t('report.cover.app'), `Decibel ${e(first.appVersion)}`]);
  }

  const meaning = [
    t('honesty.text'),
    t('report.meaning.levels'),
    t('report.meaning.events', { delta: first ? first.deltaDb : 10 }),
    t('lf.note'),
    ...(model.overloadS > 0 ? [t('report.overload', { seconds: model.overloadS })] : []),
  ];

  const summaryRows = model.nights
    .map(
      (n) => `<tr><td>${date(n.startMs, n.tzName)}</td><td>${time(n.startMs, n.tzName)}</td><td>${time(n.endMs, n.tzName)}</td>
<td>${formatDuration(n.summary.validMs)}</td><td>${formatDuration(n.summary.gapMs)}</td><td>${db(n.summary.laeq)}</td>
<td>${db(n.backgroundDb)}</td><td>${db(n.summary.lafmax, n.summary.overloadS > 0)}</td><td>${n.eventCount}</td><td>${n.events2206}</td></tr>`
    )
    .join('\n');

  const marker = (ev: ReportEventInput, peakOf: Record<number, number>) =>
    peakOf[ev.id] !== undefined ? `↳ ${t('report.event.peak')} · ` : isLongEvent(ev) ? `${t('report.event.long')} · ` : '';
  const eventTable = (events: ReportEventInput[], tzName: string, measured = true, peakOf: Record<number, number> = {}) =>
    events.length === 0
      ? `<p class="muted">${t('report.events.none')}</p>`
      : `<table class="events"><thead><tr><th>${t('report.col.date')}</th><th>${t('report.col.start')}</th><th>${t('report.col.end')}</th>
<th>${t('report.col.duration')}</th><th>${t('report.col.kind')}</th>${
          measured
            ? `<th>${t('report.col.laeq')}</th><th>${t('report.col.lafmax')}</th><th>${t('report.col.lcpeak')}</th><th>${t('report.col.lfHint')}</th>`
            : ''
        }<th>${t('report.col.effect')}</th><th>${t('report.col.witnesses')}</th><th>${t('report.col.note')}</th><th>${t('report.col.source')}</th></tr></thead><tbody>
${events
  .map(
    (ev) => `<tr><td>${date(ev.startMs, tzName)}</td><td>${time(ev.startMs, tzName)}</td><td>${time(ev.endMs, tzName)}</td>
<td>${formatDuration(ev.endMs - ev.startMs)}</td><td>${marker(ev, peakOf)}${kind(ev)}</td>${
      measured
        ? `<td>${db(ev.laeq, ev.overloadS > 0)}</td><td>${db(ev.lafmax, ev.overloadS > 0)}</td><td>${db(ev.lcpeak, ev.overloadS > 0)}</td><td>${yesNo(ev.lfHint)}</td>`
        : ''
    }<td>${effect(ev)}</td><td>${e(ev.witnesses)}</td><td>${e(ev.note)}</td><td>${t(`source.${ev.source}` as MessageKey)}</td></tr>`
  )
  .join('\n')}
</tbody></table>`;

  const nightSection = (n: NightModel) => {
    const dst = n.offsetChanges
      .map((c) => `<p class="note">${t('report.dst', { from: `UTC${formatOffset(c.fromMin)}`, to: `UTC${formatOffset(c.toMin)}` })} (${dateTime(c.atMs, n.tzName)})</p>`)
      .join('');
    const gaps =
      n.gaps.length === 0
        ? `<p class="muted">${t('report.gaps.none')}</p>`
        : `<table class="gaps"><thead><tr><th>${t('report.col.start')}</th><th>${t('report.col.end')}</th><th>${t('report.col.duration')}</th><th>${t('report.col.reason')}</th></tr></thead><tbody>
${n.gaps.map((g) => `<tr><td>${dateTime(g.startMs, n.tzName)}</td><td>${time(g.endMs, n.tzName)}</td><td>${formatDuration(g.endMs - g.startMs)}</td><td>${t(`gap.${g.reason}` as MessageKey)}</td></tr>`).join('\n')}
</tbody></table>`;
    return `<section class="night">
<h2>${e(n.title)} · ${date(n.startMs, n.tzName)}</h2>
<p>${time(n.startMs, n.tzName)} – ${time(n.endMs, n.tzName)} (UTC${formatOffset(n.startOffsetMin)}${n.endOffsetMin !== n.startOffsetMin ? ` → UTC${formatOffset(n.endOffsetMin)}` : ''})${n.place ? ` · ${e(n.place)}` : ''} · ${calibLine(n)}</p>
${dst}
${n.summary.validMs === 0 ? `<p class="muted">${t('report.noData')}</p>` : ''}
<h3>${t('report.chart.title')}</h3>
${chartSvg(n, locale)}
<p class="muted small">${t('report.chart.legend')}</p>
<h3>${t('report.events.title')}</h3>
${eventTable(n.events, n.tzName, true, n.peakOf)}
${n.excluded.length ? `<h3>${t('report.events.excluded')}</h3>${eventTable(n.excluded, n.tzName)}` : ''}
<h3>${t('report.gaps.title')}</h3>
${gaps}
</section>`;
  };

  const footer = t('report.footer');
  const pageLabel = t('report.page', { page: '\u0000P', pages: '\u0000N' });
  const pageCss = pageLabel
    .split(/(\u0000[PN])/)
    .filter(Boolean)
    .map((part) => (part === '\u0000P' ? 'counter(page)' : part === '\u0000N' ? 'counter(pages)' : cssString(part)))
    .join(' ');

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${opts.dir ?? 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('report.title')}</title>
<style>
@page { size: A4; margin: 14mm 12mm 18mm 12mm; @bottom-right { content: ${pageCss}; font-size: 8pt; color: #555; } }
body { font-family: -apple-system, Roboto, "Noto Sans", sans-serif; font-size: 9.5pt; color: #111; }
h1 { font-size: 16pt; margin: 0 0 2mm; } h2 { font-size: 12pt; margin: 6mm 0 1mm; } h3 { font-size: 10pt; margin: 4mm 0 1mm; }
table { border-collapse: collapse; width: 100%; } th, td { border: 0.3mm solid #bbb; padding: 0.8mm 1.2mm; text-align: start; vertical-align: top; }
th { background: #f0f0f3; } .cover th { width: 32%; } .box { border: 0.4mm solid #333; padding: 2mm 3mm; margin: 3mm 0; }
.chip { padding: 0 1.5mm; border-radius: 1mm; } .chip.ok { background: #d8f0dc; } .chip.warn { background: #fde7c2; }
.muted { color: #555; } .small { font-size: 8pt; } .note { color: #8a4b00; } section.night { break-before: page; }
.footer { position: fixed; bottom: -12mm; left: 0; right: 0; font-size: 8pt; color: #555; }
svg { direction: ltr; }
</style></head>
<body>
<div class="footer" id="report-footer">${footer}</div>
<h1>${t('report.title')}</h1>
<p>${model.kind === 'night' ? t('report.subtitle.night') : t('report.subtitle.case')}</p>
<table class="cover" id="report-cover">${coverRows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
<div class="box" id="report-meaning"><strong>${t('report.meaning.title')}</strong>${meaning.map((m) => `<p>${m}</p>`).join('')}</div>
<h2>${t('report.summary.title')}</h2>
<table class="summary" id="report-summary"><thead><tr><th>${t('report.col.date')}</th><th>${t('report.col.start')}</th><th>${t('report.col.end')}</th>
<th>${t('report.col.valid')}</th><th>${t('report.col.gaps')}</th><th>${t('report.col.laeq')}</th><th>${t('report.col.l90')}</th>
<th>${t('report.col.lafmax')}</th><th>${t('report.col.events')}</th><th>${t('report.col.events2206')}</th></tr></thead><tbody>
${summaryRows}
</tbody></table>
${model.nights.map(nightSection).join('\n')}
${
  model.manualEntries.length
    ? `<section><h2>${t('report.manual.title')}</h2>${eventTable(model.manualEntries, tz, false)}</section>`
    : ''
}
<section id="report-references"><h2>${t('report.reference.title')}</h2><ul>
${model.references.map((r) => `<li>${t(r.labelKey)}. ${t('ref.source', { source: `${e(r.sourceName)} (${e(r.sourceUrl)})` })}</li>`).join('\n')}
</ul></section>
</body></html>`;
}

function isKey(k: string): boolean {
  return k in messages.en;
}

/** Inline SVG: 1-min LAeq (thick) and 1-min max (thin), events shaded, empty minutes break the lines (gaps blank). */
export function chartSvg(n: Pick<NightModel, 'chart' | 'events' | 'startMs' | 'endMs' | 'tzName'>, locale = 'en-GB'): string {
  const W = 680;
  const H = 170;
  const L = 34;
  const B = 18;
  const pts = n.chart.filter((m): m is Extract<ChartMinute, { laeq: number }> => m.laeq !== null);
  if (pts.length === 0) return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" id="night-chart"></svg>`;
  const lo = Math.floor(Math.min(...pts.map((p) => p.laeq)) / 10) * 10;
  const hi = Math.max(lo + 30, Math.ceil(Math.max(...pts.map((p) => p.lmax)) / 10) * 10);
  const span = Math.max(1, n.endMs - n.startMs);
  const x = (t: number) => L + ((t - n.startMs) / span) * (W - L - 4);
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo)) * (H - B - 4);
  const lines = (key: 'laeq' | 'lmax') => {
    const segs: string[] = [];
    let cur: string[] = [];
    for (const m of n.chart) {
      if (m.laeq === null) {
        if (cur.length) segs.push(cur.join(' '));
        cur = [];
      } else cur.push(`${x(m.tMs + 30_000).toFixed(1)},${y(m[key]).toFixed(1)}`);
    }
    if (cur.length) segs.push(cur.join(' '));
    return segs;
  };
  const grid: string[] = [];
  for (let v = lo; v <= hi; v += 10)
    grid.push(`<line x1="${L}" x2="${W - 4}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#ddd" stroke-width="0.5"/><text x="${L - 3}" y="${(y(v) + 3).toFixed(1)}" font-size="8" text-anchor="end">${v}</text>`);
  // hour ticks in local time (every hour up to 12 h, else every 2 h)
  const every = span <= 12 * 3600_000 ? 3600_000 : 7200_000;
  for (let tick = Math.ceil(n.startMs / 3600_000) * 3600_000; tick <= n.endMs; tick += every)
    grid.push(`<line x1="${x(tick).toFixed(1)}" x2="${x(tick).toFixed(1)}" y1="4" y2="${H - B}" stroke="#eee" stroke-width="0.5"/><text x="${x(tick).toFixed(1)}" y="${H - 6}" font-size="8" text-anchor="middle">${formatTime(tick, n.tzName, locale)}</text>`);
  const shades = n.events.map(
    (ev) => `<rect x="${x(ev.startMs).toFixed(1)}" y="4" width="${Math.max(1, x(ev.endMs) - x(ev.startMs)).toFixed(1)}" height="${H - B - 4}" fill="#f6c97a" opacity="0.45"/>`
  );
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="night-chart">
${grid.join('')}${shades.join('')}
${lines('lmax').map((p) => `<polyline points="${p}" fill="none" stroke="#888" stroke-width="0.7"/>`).join('')}
${lines('laeq').map((p) => `<polyline points="${p}" fill="none" stroke="#0A6BD8" stroke-width="1.6"/>`).join('')}
<text x="2" y="10" font-size="8">dB(A)</text>
</svg>`;
}
