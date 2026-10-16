// Backup container (SPEC §7.9, F9; meter-tracker D48 shape): plain JSON the user shares and restores.
// { app: 'sound-meter', backupVersion: 1, schemaVersion, exportedAt, data }. Restore validates EVERYTHING first and
// refuses a newer schema or a malformed file, leaving the data unchanged (SPEC §12).
// Blocks (900-byte level records, never audio) travel as base64.

export const BACKUP_APP = 'sound-meter';
export const BACKUP_VERSION = 1;

export type BackupCase = { id: number; name: string; address: string; notes: string; createdAt: number; updatedAt: number };
export type BackupProfile = {
  id: number;
  name: string;
  deviceModel: string;
  os: string;
  route: string;
  audioSource: string;
  offsetDb: number;
  method: string;
  referenceMeter: string;
  calibratedAt: number | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};
export type BackupSession = Record<string, string | number | null> & { id: number };
export type BackupBlock = { sessionId: number; idx: number; startMs: number; data: string };
export type BackupGap = { id: number; sessionId: number; startMs: number; endMs: number; reason: string };
export type BackupEvent = Record<string, string | number | null> & { id: number };
export type BackupSetting = { key: string; value: string };

export type BackupData = {
  cases: BackupCase[];
  profiles: BackupProfile[];
  sessions: BackupSession[];
  blocks: BackupBlock[];
  gaps: BackupGap[];
  events: BackupEvent[];
  settings: BackupSetting[];
};

export type Backup = { app: typeof BACKUP_APP; backupVersion: number; schemaVersion: number; exportedAt: number; data: BackupData };

export function buildBackup(data: BackupData, schemaVersion: number, exportedAt: number): Backup {
  return { app: BACKUP_APP, backupVersion: BACKUP_VERSION, schemaVersion, exportedAt, data };
}

export type BackupError = 'not-json' | 'wrong-app' | 'newer-version' | 'invalid';
export type ValidateResult = { ok: true; backup: Backup } | { ok: false; error: BackupError; detail?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';
const isNullOr = (p: (v: unknown) => boolean) => (v: unknown) => v === null || p(v);
const oneOf = (...xs: string[]) => (v: unknown) => typeof v === 'string' && xs.includes(v);

type Shape = Record<string, (v: unknown) => boolean>;

const SHAPES: Record<keyof BackupData, Shape> = {
  cases: { id: isInt, name: isStr, address: isStr, notes: isStr, createdAt: isInt, updatedAt: isInt },
  profiles: {
    id: isInt,
    name: isStr,
    deviceModel: isStr,
    os: isStr,
    route: oneOf('builtin', 'wired', 'bluetooth', 'usb'),
    audioSource: isStr,
    offsetDb: isNum,
    method: oneOf('platform-default', 'reference-meter', 'manual-entry'),
    referenceMeter: isStr,
    calibratedAt: isNullOr(isInt),
    note: isStr,
    createdAt: isInt,
    updatedAt: isInt,
  },
  sessions: {
    id: isInt,
    caseId: isNullOr(isInt),
    kind: oneOf('quick', 'log'),
    title: isStr,
    place: isStr,
    operator: isStr,
    note: isStr,
    startedAt: isInt,
    endedAt: isNullOr(isInt),
    tzName: isStr,
    tzOffsetMin: isInt,
    status: oneOf('recording', 'finished', 'interrupted'),
    profileName: isStr,
    offsetDb: isNum,
    calibMethod: isStr,
    calibratedAt: isNullOr(isInt),
    referenceMeter: isStr,
    deviceModel: isStr,
    osVersion: isStr,
    audioSource: isStr,
    sampleRate: isInt,
    appVersion: isStr,
    sensitivity: oneOf('high', 'normal', 'low'),
    backgroundDb: isNullOr(isNum),
    summaryJson: isNullOr(isStr),
    lastHeartbeat: isNullOr(isInt),
    createdAt: isInt,
    updatedAt: isInt,
  },
  blocks: { sessionId: isInt, idx: isInt, startMs: isInt, data: (v) => isStr(v) && decodeBase64Safe(v as string)?.length === 900 },
  gaps: { id: isInt, sessionId: isInt, startMs: isInt, endMs: isInt, reason: oneOf('paused', 'interruption', 'mic-busy', 'app-killed', 'route-change', 'frames-lost') },
  events: {
    id: isInt,
    sessionId: isNullOr(isInt),
    caseId: isNullOr(isInt),
    source: oneOf('auto', 'mark', 'manual'),
    startMs: isInt,
    endMs: isInt,
    laeq: isNullOr(isNum),
    lafmax: isNullOr(isNum),
    lcpeak: isNullOr(isNum),
    lceq: isNullOr(isNum),
    lfHint: isNullOr(isInt),
    overloadS: isInt,
    category: isNullOr(isStr),
    categoryOther: isStr,
    note: isStr,
    witnesses: isStr,
    effect: isNullOr(oneOf('woke', 'kept-awake', 'disturbed', 'none')),
    excluded: (v) => v === 0 || v === 1,
    createdAt: isInt,
    updatedAt: isInt,
  },
  settings: { key: isStr, value: isStr },
};

/** The columns restored per table: only these keys are ever written (extra keys in a file are ignored). */
export const BACKUP_COLUMNS: Record<keyof BackupData, readonly string[]> = Object.fromEntries(
  Object.entries(SHAPES).map(([t, shape]) => [t, Object.keys(shape)])
) as unknown as Record<keyof BackupData, readonly string[]>;

/** Validates a parsed or raw JSON backup completely (shape + references) before anything is written. */
export function validateBackup(input: unknown, currentSchemaVersion: number): ValidateResult {
  let v: unknown = input;
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input);
    } catch {
      return { ok: false, error: 'not-json' };
    }
  }
  if (!isObj(v) || v.app !== BACKUP_APP) return { ok: false, error: 'wrong-app' };
  if (!isInt(v.backupVersion) || !isInt(v.schemaVersion) || !isInt(v.exportedAt)) return { ok: false, error: 'invalid', detail: 'header' };
  if ((v.backupVersion as number) > BACKUP_VERSION || (v.schemaVersion as number) > currentSchemaVersion)
    return { ok: false, error: 'newer-version' };
  if (!isObj(v.data)) return { ok: false, error: 'invalid', detail: 'data' };
  const data = v.data;
  for (const [table, shape] of Object.entries(SHAPES)) {
    const rows = data[table];
    if (!Array.isArray(rows)) return { ok: false, error: 'invalid', detail: table };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!isObj(row)) return { ok: false, error: 'invalid', detail: `${table}[${i}]` };
      for (const [col, check] of Object.entries(shape))
        if (!check(row[col])) return { ok: false, error: 'invalid', detail: `${table}[${i}].${col}` };
    }
  }
  const d = data as unknown as BackupData;
  const ids = (rows: { id: number }[]) => new Set(rows.map((r) => r.id));
  const cases = ids(d.cases);
  const sessions = ids(d.sessions);
  if (cases.size !== d.cases.length || sessions.size !== d.sessions.length) return { ok: false, error: 'invalid', detail: 'duplicate id' };
  for (const s of d.sessions) if (s.caseId !== null && !cases.has(s.caseId as number)) return { ok: false, error: 'invalid', detail: 'session case' };
  for (const b of d.blocks) if (!sessions.has(b.sessionId)) return { ok: false, error: 'invalid', detail: 'block session' };
  for (const g of d.gaps) if (!sessions.has(g.sessionId)) return { ok: false, error: 'invalid', detail: 'gap session' };
  for (const e of d.events) {
    if (e.sessionId === null && e.caseId === null) return { ok: false, error: 'invalid', detail: 'event owner' };
    if (e.sessionId !== null && !sessions.has(e.sessionId as number)) return { ok: false, error: 'invalid', detail: 'event session' };
    if (e.caseId !== null && !cases.has(e.caseId as number)) return { ok: false, error: 'invalid', detail: 'event case' };
  }
  return { ok: true, backup: v as unknown as Backup };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (RFC 4648) without relying on btoa/Buffer (Hermes and Node alike). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

export function decodeBase64(s: string): Uint8Array {
  const r = decodeBase64Safe(s);
  if (!r) throw new Error('invalid base64');
  return r;
}

function decodeBase64Safe(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (ALPHABET.indexOf(s[i]) << 18) |
      (ALPHABET.indexOf(s[i + 1]) << 12) |
      ((s[i + 2] === '=' ? 0 : ALPHABET.indexOf(s[i + 2])) << 6) |
      (s[i + 3] === '=' ? 0 : ALPHABET.indexOf(s[i + 3]));
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
