// Shared test fixtures for DB and report tests.
import type { NewSession } from '@/db/sessions';
import { DEFAULT_OFFSET_DB } from '@/engine/calibration';

export function newSession(over: Partial<NewSession> = {}): NewSession {
  return {
    caseId: null,
    kind: 'log',
    title: 'Night 24 Oct',
    place: 'Bedroom, window closed',
    operator: 'Tim',
    note: '',
    startedAt: Date.UTC(2026, 9, 24, 20, 0, 0),
    tzName: 'Europe/Berlin',
    tzOffsetMin: 120,
    profileName: 'Built-in microphone',
    offsetDb: DEFAULT_OFFSET_DB,
    calibMethod: 'platform-default',
    calibratedAt: null,
    referenceMeter: '',
    deviceModel: 'Pixel 8 Pro',
    osVersion: 'Android 16',
    audioSource: 'unprocessed',
    sampleRate: 48000,
    appVersion: '1.0.0',
    sensitivity: 'normal',
    ...over,
  };
}
