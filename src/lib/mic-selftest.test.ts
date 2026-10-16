// The P3 self-test runner against the Node fake mic: the same code the dev screen runs on the devices.
import { createFakeMic } from '../../modules/mic-pcm/src/fake';

import { captureRun, coverage, E1_RMS_DBFS, fullSecondsLaeq, msPerAudioSecond, parseWavF32 } from './mic-selftest';

import { sineAmplitudeForRmsDbfs } from '@/engine/signals';

const flush = () => new Promise((r) => setImmediate(r));

function e1Fake() {
  const a = sineAmplitudeForRmsDbfs(E1_RMS_DBFS);
  return createFakeMic({
    startTimeMs: Date.now(),
    generator: (pos, n, fs) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * (pos + i)) / fs)),
  });
}

describe('mic self-test runner (fake mic)', () => {
  it('E1 through captureRun reads 94.0 dB and covers every second', async () => {
    const mic = e1Fake();
    const p = captureRun(mic, { seconds: 6 });
    await flush();
    mic.pump(6.5);
    const run = await p;
    const a = fullSecondsLaeq(run.records);
    expect(Math.abs(a.laeq - 94)).toBeLessThan(0.05);
    expect(run.probe.dropped).toBe(0);
    expect(run.probe.bursts).toBe(1);
    expect(run.probe.maxJitterMs).toBeLessThan(1e-6);
    expect(msPerAudioSecond(run.probe)).toBeGreaterThan(0);
    const cov = coverage(run.records, run.gaps, run.sessionStartMs, run.endMs);
    expect(cov.pct).toBeGreaterThanOrEqual(99.5);
    expect(run.gaps).toEqual([]);
  });

  it('lost frames become exactly one frames-lost gap of their length', async () => {
    const mic = e1Fake();
    const p = captureRun(mic, { seconds: 8 });
    await flush();
    mic.pump(3);
    mic.drop(48000 * 2); // 2 s lost from the ring
    mic.pump(6);
    const run = await p;
    const lost = run.gaps.filter((g) => g.reason === 'frames-lost');
    expect(lost).toHaveLength(1);
    expect(Math.abs(lost[0].endMs - lost[0].startMs - 2000)).toBeLessThanOrEqual(1);
    expect(run.probe.dropped).toBe(96000);
    expect(run.probe.breaks).toHaveLength(1);
  });

  it('parseWavF32 reads a mono float32 WAV', () => {
    const x = Float32Array.from([0, 0.5, -0.25, 1]);
    const b = new ArrayBuffer(44 + x.byteLength);
    const v = new DataView(b);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + x.byteLength, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 3, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true);
    v.setUint32(28, 48000 * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 32, true);
    str(36, 'data');
    v.setUint32(40, x.byteLength, true);
    x.forEach((s, i) => v.setFloat32(44 + 4 * i, s, true));
    expect(parseWavF32(b)).toEqual({ fs: 48000, x });
  });
});
