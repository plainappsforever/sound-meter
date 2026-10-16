/**
 * @jest-environment node
 */
import { HEARTBEAT_STALE_MS, MAX_SESSION_MS, logReducer, openGaps, recoverSession, startLog, type LogEvent } from './session';
import { formatDate, formatDuration, formatOffset, formatTime, isNightTime, isoLocal, offsetChanges, offsetMinutes } from './time';

describe('time zones and DST (SPEC §12)', () => {
  it('Europe/Berlin night of the 2026-10-25 clock change: offsets, change instant, ISO strings', () => {
    const start = Date.UTC(2026, 9, 24, 20, 0); // 22:00 CEST
    const end = Date.UTC(2026, 9, 25, 5, 0); // 06:00 CET
    expect(offsetMinutes(start, 'Europe/Berlin')).toBe(120);
    expect(offsetMinutes(end, 'Europe/Berlin')).toBe(60);
    const ch = offsetChanges(start, end, 'Europe/Berlin');
    expect(ch).toEqual([{ atMs: Date.UTC(2026, 9, 25, 1, 0), fromMin: 120, toMin: 60 }]);
    expect(isoLocal(Date.UTC(2026, 9, 25, 0, 30), 'Europe/Berlin')).toBe('2026-10-25T02:30:00+02:00');
    expect(isoLocal(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Berlin')).toBe('2026-10-25T02:30:00+01:00');
  });

  it('America/New_York 2026-11-01 fall back and 2026-03-08 spring forward', () => {
    const fall = offsetChanges(Date.UTC(2026, 10, 1, 2), Date.UTC(2026, 10, 1, 12), 'America/New_York');
    expect(fall).toEqual([{ atMs: Date.UTC(2026, 10, 1, 6), fromMin: -240, toMin: -300 }]);
    const spring = offsetChanges(Date.UTC(2026, 2, 8, 2), Date.UTC(2026, 2, 8, 12), 'America/New_York');
    expect(spring).toEqual([{ atMs: Date.UTC(2026, 2, 8, 7), fromMin: -300, toMin: -240 }]);
    expect(isoLocal(Date.UTC(2026, 2, 8, 7, 0, 5), 'America/New_York')).toBe('2026-03-08T03:00:05-04:00');
  });

  it('no change in a summer night; night window 22–06 local; formatting', () => {
    expect(offsetChanges(Date.UTC(2026, 6, 1, 20), Date.UTC(2026, 6, 2, 4), 'Europe/Berlin')).toEqual([]);
    expect(isNightTime(Date.UTC(2026, 6, 1, 20, 0), 'Europe/Berlin')).toBe(true); // 22:00
    expect(isNightTime(Date.UTC(2026, 6, 1, 19, 59), 'Europe/Berlin')).toBe(false);
    expect(isNightTime(Date.UTC(2026, 6, 2, 3, 59), 'Europe/Berlin')).toBe(true); // 05:59
    expect(isNightTime(Date.UTC(2026, 6, 2, 4, 0), 'Europe/Berlin')).toBe(false);
    expect(formatOffset(-330)).toBe('-05:30');
    expect(formatDate(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Berlin', 'de-DE')).toBe('25.10.2026');
    expect(formatTime(Date.UTC(2026, 9, 25, 13, 5), 'Europe/Berlin', 'en-US')).toBe('14:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(65_000)).toBe('1:05');
  });
});

describe('log state machine and recovery', () => {
  const t0 = 1_000_000;
  const run = (events: LogEvent[]) => events.reduce(logReducer, startLog(t0));

  it('pause/interruption/mic-busy/route changes become gaps with their reason', () => {
    const s = run([
      { type: 'pause', t: t0 + 10_000 },
      { type: 'resume', t: t0 + 20_000 },
      { type: 'interruption-began', t: t0 + 30_000 },
      { type: 'mic-busy', t: t0 + 31_000 }, // its own cause (M3): closed at stop, overlaps the interruption
      { type: 'mic-back', t: t0 + 40_000 },
      { type: 'interruption-ended', t: t0 + 50_000 },
      { type: 'route-change', t: t0 + 60_000, builtin: false },
      { type: 'route-change', t: t0 + 65_000, builtin: true },
      { type: 'mic-busy', t: t0 + 70_000 },
      { type: 'stop', t: t0 + 80_000 },
    ]);
    expect(s.phase).toBe('finished');
    expect(s.endedAt).toBe(t0 + 80_000);
    expect(s.gaps.map((g) => [g.reason, g.startMs - t0, g.endMs - t0])).toEqual([
      ['paused', 10_000, 20_000],
      ['mic-busy', 31_000, 40_000],
      ['interruption', 30_000, 50_000],
      ['route-change', 60_000, 65_000],
      ['mic-busy', 70_000, 80_000],
    ]);
  });

  // Review M3: every interleaving of the user's pause with a device gap. The pause is always honoured (phase
  // 'paused' while it is open), and the other cause keeps its own gap.
  const others = [
    { name: 'interruption', open: { type: 'interruption-began' }, close: { type: 'interruption-ended' } },
    { name: 'mic-busy', open: { type: 'mic-busy' }, close: { type: 'mic-back' } },
    { name: 'route-change', open: { type: 'route-change', builtin: false }, close: { type: 'route-change', builtin: true } },
  ] as const;
  const at = (e: object, t: number) => ({ ...e, t: t0 + t }) as LogEvent;
  for (const o of others) {
    it(`M3: ${o.name} → pause → ${o.name} ends → resume: paused until resume, both gaps kept`, () => {
      let s = startLog(t0);
      s = logReducer(s, at(o.open, 60_000));
      s = logReducer(s, at({ type: 'pause' }, 70_000));
      expect(s.phase).toBe('paused');
      s = logReducer(s, at(o.close, 80_000));
      expect(s.phase).toBe('paused'); // the reviewer's case: was 'recording' → 520 s measured during the pause
      s = logReducer(s, at({ type: 'resume' }, 600_000));
      expect(s.phase).toBe('recording');
      expect(s.gaps.map((g) => [g.reason, g.startMs - t0, g.endMs - t0])).toEqual([
        [o.name, 60_000, 80_000],
        ['paused', 70_000, 600_000],
      ]);
    });
    it(`M3: pause → ${o.name} → resume → ${o.name} ends: the device gap survives the resume`, () => {
      let s = startLog(t0);
      s = logReducer(s, at({ type: 'pause' }, 10_000));
      s = logReducer(s, at(o.open, 20_000));
      s = logReducer(s, at({ type: 'resume' }, 30_000));
      expect(s.phase).toBe('gap');
      s = logReducer(s, at(o.close, 90_000));
      expect(s.phase).toBe('recording');
      expect(s.gaps.map((g) => [g.reason, g.startMs - t0, g.endMs - t0])).toEqual([
        ['paused', 10_000, 30_000],
        [o.name, 20_000, 90_000],
      ]);
    });
    it(`M3: ${o.name} open at stop and pause open at stop both end at the stop`, () => {
      const s = run([at(o.open, 5_000), at({ type: 'pause' }, 6_000), at({ type: 'stop' }, 9_000)]);
      expect(s.gaps.map((g) => [g.reason, g.startMs - t0, g.endMs - t0])).toEqual([
        ['paused', 6_000, 9_000],
        [o.name, 5_000, 9_000],
      ]);
    });
  }

  it('S7: an unsupported sample rate is a route-change gap of its own', () => {
    const s = run([at({ type: 'format-unsupported' }, 1_000), at({ type: 'route-change', builtin: false }, 1_000), at({ type: 'format-ok' }, 4_000), at({ type: 'route-change', builtin: true }, 5_000)]);
    expect(s.gaps.map((g) => [g.reason, g.startMs - t0, g.endMs - t0])).toEqual([
      ['route-change', 1_000, 4_000],
      ['route-change', 1_000, 5_000],
    ]);
    expect(openGaps(logReducer(startLog(t0), at({ type: 'pause' }, 1)))).toEqual([{ cause: 'paused', startMs: t0 + 1, reason: 'paused' }]);
  });

  it('finalises itself at 24 h; ignores events after finishing', () => {
    const s = run([{ type: 'tick', t: t0 + MAX_SESSION_MS + 5 }, { type: 'pause', t: t0 + MAX_SESSION_MS + 10 }]);
    expect(s.phase).toBe('finished');
    expect(s.endedAt).toBe(t0 + MAX_SESSION_MS);
    expect(s.gaps).toEqual([]);
  });

  it('recovery: stale heartbeat closes at the last sign of life (S2) with an app-killed gap for the lost tail inside it', () => {
    const r = recoverSession(
      { status: 'recording', startedAt: t0, lastHeartbeat: t0 + 600_000, lastDataEndMs: t0 + 560_000 },
      t0 + 600_000 + HEARTBEAT_STALE_MS
    );
    expect(r).toEqual({ status: 'interrupted', endedAt: t0 + 600_000, gap: { startMs: t0 + 560_000, endMs: t0 + 600_000, reason: 'app-killed' } });
    // review S8: the recorder's own answer outranks the heartbeat age
    const fresh = { status: 'recording' as const, startedAt: t0, lastHeartbeat: t0 + 600_000, lastDataEndMs: t0 + 600_000 };
    expect(recoverSession({ ...fresh, recorderAlive: false }, t0 + 610_000)).toEqual({ status: 'interrupted', endedAt: t0 + 600_000, gap: null });
    expect(recoverSession({ ...fresh, recorderAlive: true }, t0 + 1e9)).toBeNull();
    expect(recoverSession({ ...fresh, recorderAlive: null }, t0 + 610_000)).toBeNull();
    expect(recoverSession({ status: 'recording', startedAt: t0, lastHeartbeat: t0, lastDataEndMs: null }, t0 + 60_000)).toBeNull();
    expect(recoverSession({ status: 'finished', startedAt: t0, lastHeartbeat: t0, lastDataEndMs: t0 }, t0 + 1e9)).toBeNull();
    expect(recoverSession({ status: 'recording', startedAt: t0, lastHeartbeat: null, lastDataEndMs: null }, t0 + 1e9)).toEqual({
      status: 'interrupted',
      endedAt: t0,
      gap: null,
    });
  });
});
