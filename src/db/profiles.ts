// Calibration profiles per phone and input route (SPEC §6, F6, D18). Sessions keep their own snapshot, so editing or
// recalibrating a profile never changes old reports.
import type { AudioSource, CalibMethod } from '@/engine/calibration';

import { getSetting, setSetting } from './settings';
import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type Route = 'builtin' | 'wired' | 'bluetooth' | 'usb';
export const ROUTES: readonly Route[] = ['builtin', 'wired', 'bluetooth', 'usb'];

export type Profile = {
  id: number;
  name: string;
  deviceModel: string;
  os: string;
  route: Route;
  audioSource: AudioSource;
  offsetDb: number;
  method: CalibMethod;
  referenceMeter: string;
  calibratedAt: number | null;
  note: string;
  createdAt: number;
  updatedAt: number;
};
export type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>;

type Row = {
  id: number;
  name: string;
  device_model: string;
  os: string;
  route: Route;
  audio_source: AudioSource;
  offset_db: number;
  method: CalibMethod;
  reference_meter: string;
  calibrated_at: number | null;
  note: string;
  created_at: number;
  updated_at: number;
};
const COLS =
  'id, name, device_model, os, route, audio_source, offset_db, method, reference_meter, calibrated_at, note, created_at, updated_at';
const map = (r: Row): Profile => ({
  id: r.id,
  name: r.name,
  deviceModel: r.device_model,
  os: r.os,
  route: r.route,
  audioSource: r.audio_source,
  offsetDb: r.offset_db,
  method: r.method,
  referenceMeter: r.reference_meter,
  calibratedAt: r.calibrated_at,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listProfiles(db: Db): Promise<Profile[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>(`SELECT ${COLS} FROM profiles ORDER BY route, name, id`));
  return rows.map(map);
}

export async function getProfile(db: Db, id: number): Promise<Profile | null> {
  const row = await withRead(db, (r) => r.getFirstAsync<Row>(`SELECT ${COLS} FROM profiles WHERE id = ?`, id));
  return row ? map(row) : null;
}

export async function createProfile(db: Db, p: ProfileInput, now = Date.now()): Promise<number> {
  return withWrite(db, async (tx) => {
    const res = await tx.runAsync(
      `INSERT INTO profiles (name, device_model, os, route, audio_source, offset_db, method, reference_meter,
         calibrated_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name,
      p.deviceModel,
      p.os,
      p.route,
      p.audioSource,
      p.offsetDb,
      p.method,
      p.referenceMeter,
      p.calibratedAt,
      p.note,
      now,
      now
    );
    return res.lastInsertRowId;
  });
}

/** Stores a new calibration result on a profile. */
export async function updateCalibration(
  db: Db,
  id: number,
  c: { offsetDb: number; method: CalibMethod; referenceMeter: string; calibratedAt: number | null },
  now = Date.now()
): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      'UPDATE profiles SET offset_db = ?, method = ?, reference_meter = ?, calibrated_at = ?, updated_at = ? WHERE id = ?',
      c.offsetDb,
      c.method,
      c.referenceMeter,
      c.calibratedAt,
      now,
      id
    )
  );
}

export async function deleteProfile(db: Db, id: number): Promise<void> {
  await withWrite(db, (tx) => tx.runAsync('DELETE FROM profiles WHERE id = ?', id));
}

const activeKey = (route: Route) => `activeProfile.${route}`;

/** The active profile for a route (setting `activeProfile.<route>`), or null when none is set or it was deleted. */
export async function getActiveProfile(db: Db, route: Route): Promise<Profile | null> {
  const v = await getSetting(db, activeKey(route));
  const id = v === null ? NaN : Number(v);
  return Number.isInteger(id) ? getProfile(db, id) : null;
}

export function setActiveProfile(db: Db, route: Route, id: number): Promise<void> {
  return setSetting(db, activeKey(route), String(id));
}
