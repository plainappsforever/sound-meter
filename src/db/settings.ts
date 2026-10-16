import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme';
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await withRead(db, (r) =>
    r.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
  );
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    )
  );
}

export async function getThemePreference(db: Db): Promise<ThemePreference> {
  const value = await getSetting(db, THEME_KEY);
  return THEMES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export function setThemePreference(db: Db, theme: ThemePreference): Promise<void> {
  return setSetting(db, THEME_KEY, theme);
}

// App defaults (SPEC §6 `settings`, F8). Unknown/invalid stored values fall back to the default.
export const APP_SETTINGS = {
  weighting: { key: 'weighting', values: ['A', 'C', 'Z'], default: 'A' },
  timeWeighting: { key: 'timeWeighting', values: ['F', 'S'], default: 'F' },
  chartWindow: { key: 'chartWindow', values: ['1', '5', '15'], default: '5' },
  sensitivity: { key: 'sensitivity', values: ['high', 'normal', 'low'], default: 'normal' },
  keepLoggingLocked: { key: 'keepLoggingLocked', values: ['1', '0'], default: '1' },
  language: { key: 'language', values: ['system', 'en', 'de'], default: 'system' },
} as const;

export type AppSettingName = keyof typeof APP_SETTINGS;
export type AppSettingValue<N extends AppSettingName> = (typeof APP_SETTINGS)[N]['values'][number];

export async function getAppSetting<N extends AppSettingName>(db: Db, name: N): Promise<AppSettingValue<N>> {
  const def = APP_SETTINGS[name];
  const v = await getSetting(db, def.key);
  return ((def.values as readonly string[]).includes(v ?? '') ? v : def.default) as AppSettingValue<N>;
}

export function setAppSetting<N extends AppSettingName>(db: Db, name: N, value: AppSettingValue<N>): Promise<void> {
  return setSetting(db, APP_SETTINGS[name].key, value);
}

const LAST_BACKUP_KEY = 'lastBackupAt';

export async function getLastBackupAt(db: Db): Promise<number | null> {
  const v = Number(await getSetting(db, LAST_BACKUP_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function setLastBackupAt(db: Db, t: number): Promise<void> {
  return setSetting(db, LAST_BACKUP_KEY, String(t));
}
