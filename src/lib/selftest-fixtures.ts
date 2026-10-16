// Dev-only (required behind __DEV__ by the self-test screen, so Release bundles never contain these files): a subset
// of blind set 1's PCM fixtures, served by Metro as assets and injected into the native ring by the P3 self-test.
// The comparison against the set's expectations runs in Node (test/blind/device-chain.test.ts) on the levels the
// device logged — PCM never leaves the device.
import { Image } from 'react-native';

import { parseWavF32, type InjectFixture } from './mic-selftest';

const ASSETS: Record<string, number> = {
  S01: require('../../test/blind/set-1/signals/S01_e1-cal-1k-48k.wav'),
  S02: require('../../test/blind/set-1/signals/S02_e1-cal-1k-44k.wav'),
  S03: require('../../test/blind/set-1/signals/S03_e2-100Hz-LZ94-48k.wav'),
  S11: require('../../test/blind/set-1/signals/S11_sine-1000Hz-44k.wav'),
  S12: require('../../test/blind/set-1/signals/S12_sine-1995Hz-48k.wav'),
  S13: require('../../test/blind/set-1/signals/S13_sine-3981Hz-44k.wav'),
  S16: require('../../test/blind/set-1/signals/S16_sine-10000Hz-48k.wav'),
  S19: require('../../test/blind/set-1/signals/S19_pink-noise-20-20k-48k.wav'),
  S20: require('../../test/blind/set-1/signals/S20_pink-noise-20-20k-44k.wav'),
  S23: require('../../test/blind/set-1/signals/S23_pink-multitone-31x3oct-48k.wav'),
  S24: require('../../test/blind/set-1/signals/S24_pink-multitone-31x3oct-44k.wav'),
  S25: require('../../test/blind/set-1/signals/S25_burst-4k-fast-200ms-48k.wav'),
  S27: require('../../test/blind/set-1/signals/S27_burst-4k-fast-50ms-44k.wav'),
  S30: require('../../test/blind/set-1/signals/S30_step-fast-1k-48k.wav'),
  S33: require('../../test/blind/set-1/signals/S33_clip-hard-1k-amp2-48k.wav'),
  S41: require('../../test/blind/set-1/signals/S41_silence-exact-zeros-48k.wav'),
};

/** Loads the fixtures whose rate equals `fs` (no resampling: the injection runs at the hardware rate). */
export async function loadFixtures(fs: number, ids?: string[]): Promise<InjectFixture[]> {
  const out: InjectFixture[] = [];
  for (const [id, asset] of Object.entries(ASSETS)) {
    if (ids && !ids.includes(id)) continue;
    const uri = Image.resolveAssetSource(asset).uri;
    const res = await fetch(uri);
    const { fs: rate, x } = parseWavF32(await res.arrayBuffer());
    if (rate === fs) out.push({ id, fs: rate, pcm: x });
  }
  return out;
}
