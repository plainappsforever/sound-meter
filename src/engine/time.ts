// Time zones and DST (SPEC §6, §12): storage is UTC epoch ms; every session keeps its zone name; reports show local
// time with the zone and any clock change inside the period. Uses Intl.DateTimeFormat (formatToParts with timeZone),
// which Node and Hermes (iOS/Android) provide. Hermes behaviour is IMPLEMENTED BUT UNVERIFIED until P5 renders a report.

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `utcMs` in zone `tz`. */
export function localParts(utcMs: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(utcMs)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** UTC offset of zone `tz` at `utcMs`, in minutes (Berlin summer = +120). */
export function offsetMinutes(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** "+02:00" / "−05:00" style offset (ASCII minus for machine formats). */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 local time with offset, e.g. 2026-10-25T02:30:00+01:00 (CSV, SPEC §7.9). */
export function isoLocal(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(
    offsetMinutes(utcMs, tz)
  )}`;
}

/** Local hour is in the night window 22:00–06:00 (report column "events 22–06"). */
export function isNightTime(utcMs: number, tz: string): boolean {
  const h = localParts(utcMs, tz).hour;
  return h >= 22 || h < 6;
}

export type OffsetChange = { atMs: number; fromMin: number; toMin: number };

/** Clock changes (DST, zone rule changes) between start and end, located to the minute. */
export function offsetChanges(startMs: number, endMs: number, tz: string): OffsetChange[] {
  const out: OffsetChange[] = [];
  const step = 3600_000;
  let t = startMs;
  let off = offsetMinutes(t, tz);
  while (t < endMs) {
    const next = Math.min(t + step, endMs);
    const offNext = offsetMinutes(next, tz);
    if (offNext !== off) {
      let lo = t;
      let hi = next; // offset(lo) = off, offset(hi) = offNext
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000 || lo + 60_000;
        if (offsetMinutes(mid, tz) === off) lo = mid;
        else hi = mid;
      }
      out.push({ atMs: hi, fromMin: off, toMin: offNext });
      off = offNext;
    }
    t = next;
  }
  return out;
}

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function display(locale: string, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = displayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts });
    displayFormatters.set(key, f);
  }
  return f;
}

/** Local date for reports, e.g. "25.10.2026" (de-DE) / "10/25/2026" (en-US). */
export function formatDate(utcMs: number, tz: string, locale: string): string {
  return display(locale, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcMs));
}

/** Local time HH:MM (24 h in every locale: protocols are compared across languages). */
export function formatTime(utcMs: number, tz: string, locale: string, seconds = false): string {
  return display(locale, tz, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).format(new Date(utcMs));
}

/** Duration as h:mm:ss or m:ss. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
