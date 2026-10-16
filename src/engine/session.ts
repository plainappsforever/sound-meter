// Session lifecycle as pure logic (SPEC §6, §7.5, §12, F3): the log state machine that turns capture events into
// gaps, and the recovery rule after the app was killed. The recorder service (P3/P5) feeds it; the DB stores results.
import type { Gap, GapReason } from './levels';

export const MAX_SESSION_MS = 24 * 3600_000;
export const QUICK_MAX_MS = 2 * 3600_000;
/** A `recording` session whose heartbeat is older than this is treated as killed (SPEC V1_PLAN P2). */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
export const HEARTBEAT_EVERY_MS = 30_000;

export type LogPhase = 'recording' | 'paused' | 'gap' | 'finished';

/**
 * Causes of a gap. They are tracked SEPARATELY (review M3): a pause during an interruption or a route-change gap is
 * always honoured, and each cause becomes its own gap row when it ends — rows may overlap; totals use their union
 * (levels.ts gapTotalMs). `format` = the input runs at a sample rate the meter refuses (S7); its rows say `route-change`.
 */
export type GapCause = 'paused' | 'interruption' | 'mic-busy' | 'route-change' | 'format';
export const GAP_CAUSES: readonly GapCause[] = ['paused', 'interruption', 'mic-busy', 'route-change', 'format'];
export const CAUSE_REASON: Record<GapCause, GapReason> = {
  paused: 'paused',
  interruption: 'interruption',
  'mic-busy': 'mic-busy',
  'route-change': 'route-change',
  format: 'route-change',
};

export type LogState = {
  /** `paused` whenever the user's pause is open (it wins), else `gap` while any other cause is open. */
  phase: LogPhase;
  startedAt: number;
  /** Start time of every open cause. */
  open: Partial<Record<GapCause, number>>;
  gaps: Gap[];
  endedAt: number | null;
};

export type LogEvent =
  | { type: 'pause'; t: number }
  | { type: 'resume'; t: number }
  | { type: 'interruption-began'; t: number }
  | { type: 'interruption-ended'; t: number }
  | { type: 'mic-busy'; t: number }
  | { type: 'mic-back'; t: number }
  | { type: 'route-change'; t: number; builtin: boolean }
  | { type: 'format-unsupported'; t: number }
  | { type: 'format-ok'; t: number }
  | { type: 'tick'; t: number }
  | { type: 'stop'; t: number };

export function startLog(startedAt: number): LogState {
  return { phase: 'recording', startedAt, open: {}, gaps: [], endedAt: null };
}

function phaseOf(open: LogState['open']): LogPhase {
  if (open.paused !== undefined) return 'paused';
  return GAP_CAUSES.some((c) => open[c] !== undefined) ? 'gap' : 'recording';
}

function openCause(s: LogState, t: number, cause: GapCause): LogState {
  if (s.open[cause] !== undefined) return s; // already open: keeps its start
  const open = { ...s.open, [cause]: t };
  return { ...s, open, phase: phaseOf(open) };
}

function closeCause(s: LogState, t: number, cause: GapCause): LogState {
  const startMs = s.open[cause];
  if (startMs === undefined) return s;
  const open = { ...s.open };
  delete open[cause];
  const gap: Gap = { startMs, endMs: Math.max(t, startMs), reason: CAUSE_REASON[cause] };
  return { ...s, open, phase: phaseOf(open), gaps: gap.endMs > gap.startMs ? [...s.gaps, gap] : s.gaps };
}

function finish(s: LogState, t: number): LogState {
  const end = Math.min(t, s.startedAt + MAX_SESSION_MS);
  let closed = s;
  for (const c of GAP_CAUSES) closed = closeCause(closed, end, c);
  return { ...closed, phase: 'finished', endedAt: end };
}

/** Open causes as gap starts (for storing an open gap at once, review S4). */
export function openGaps(s: LogState): { cause: GapCause; startMs: number; reason: GapReason }[] {
  return GAP_CAUSES.filter((c) => s.open[c] !== undefined).map((c) => ({ cause: c, startMs: s.open[c]!, reason: CAUSE_REASON[c] }));
}

/**
 * Transition function. Gaps: pause → `paused`; iOS interruption → `interruption`; a second of zeros (Android) →
 * `mic-busy`; a route change to a non-built-in mic → `route-change` until the built-in mic is back; an unsupported
 * sample rate → `route-change` until a supported one is back. Every cause opens and closes on its own (M3).
 * `tick` finalises a log that reached 24 h (SPEC F3). Events after `finished` are ignored.
 */
export function logReducer(s: LogState, e: LogEvent): LogState {
  if (s.phase === 'finished') return s;
  if (e.t - s.startedAt >= MAX_SESSION_MS && e.type !== 'stop') return finish(s, s.startedAt + MAX_SESSION_MS);
  switch (e.type) {
    case 'pause':
      return openCause(s, e.t, 'paused');
    case 'resume':
      return closeCause(s, e.t, 'paused');
    case 'interruption-began':
      return openCause(s, e.t, 'interruption');
    case 'interruption-ended':
      return closeCause(s, e.t, 'interruption');
    case 'mic-busy':
      return openCause(s, e.t, 'mic-busy');
    case 'mic-back':
      return closeCause(s, e.t, 'mic-busy');
    case 'route-change':
      return e.builtin ? closeCause(s, e.t, 'route-change') : openCause(s, e.t, 'route-change');
    case 'format-unsupported':
      return openCause(s, e.t, 'format');
    case 'format-ok':
      return closeCause(s, e.t, 'format');
    case 'tick':
      return s;
    case 'stop':
      return finish(s, e.t);
  }
}

export type RecoveryInput = {
  status: 'recording' | 'finished' | 'interrupted';
  startedAt: number;
  lastHeartbeat: number | null;
  /** End of the last stored second (last record tMs + 1000), or null if nothing was stored. */
  lastDataEndMs: number | null;
  /**
   * Is a recorder for this session alive right now (review S8)? Asked of the recorder service in this process and of
   * the native module (an Android foreground service can outlive a JS reload). `true` → never recover; `false` → dead
   * now, whatever the heartbeat says (a crash and a reopen within 3 min); `null`/absent → unknown, heartbeat age decides.
   */
  recorderAlive?: boolean | null;
};

export type Recovery = { status: 'interrupted'; endedAt: number; gap: Gap | null };

/**
 * Recovery after a kill/restart (SPEC §7.5): a `recording` session without a live recorder (or, if that is unknown,
 * with a heartbeat older than 3 min) is closed as `interrupted` at its LAST SIGN OF LIFE — the later of the last stored
 * second and the last heartbeat (review S2: so the lost stretch lies inside the session, not after its end). The
 * stretch between the last stored second and the heartbeat was measured but lost before it was written: it becomes an
 * `app-killed` gap. Open gap rows are closed at `endedAt` by the caller (src/db/sessions.ts, review S4).
 */
export function recoverSession(s: RecoveryInput, nowMs: number): Recovery | null {
  if (s.status !== 'recording') return null;
  if (s.recorderAlive === true) return null;
  const beat = s.lastHeartbeat ?? s.startedAt;
  if (s.recorderAlive !== false && nowMs - beat < HEARTBEAT_STALE_MS) return null;
  const dataEnd = s.lastDataEndMs ?? s.startedAt;
  const endedAt = Math.max(dataEnd, beat);
  const gap = beat > dataEnd ? { startMs: dataEnd, endMs: beat, reason: 'app-killed' as const } : null;
  return { status: 'interrupted', endedAt, gap };
}
