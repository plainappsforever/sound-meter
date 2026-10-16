// JS side of the native module (P3): implements the typed MicPcm interface (MicPcm.types.ts) on top of the Swift/Kotlin
// module "MicPcm". PCM arrives either pushed (`buffer` events carrying an ArrayBuffer, acknowledged one by one so the
// native side stops sending while JS is stalled and reports the loss as `dropped`) or pulled with read() into a fresh
// Float32Array. Nothing here stores audio (D13).
import { requireOptionalNativeModule } from 'expo';

import type {
  CaptureState,
  MicEvents,
  MicInfo,
  MicPcm,
  PcmChunk,
  PermissionState,
  StartOptions,
  StartResult,
  Subscription,
  SyntheticSpec,
} from './MicPcm.types';

type NativeBuffer = {
  /** iOS: Uint8Array (Swift Data); Android: ArrayBuffer (NativeArrayBuffer). Float32 little-endian, mono. */
  data: ArrayBuffer | Uint8Array;
  frames: number;
  framePos: number;
  tMs: number;
  dropped: number;
  discontinuity: boolean;
  sampleRate: number;
};

type NativeEvents = Omit<MicEvents, 'buffer'> & { buffer: NativeBuffer };

/** Dev-build statistics of the native capture (P3 spike numbers). */
export type MicDebugStats = Record<string, number | boolean>;

type NativeMicPcm = {
  getInfo(): Promise<MicInfo>;
  requestPermission(): Promise<PermissionState>;
  start(options: StartOptions): Promise<StartResult>;
  stop(): Promise<void>;
  readInto(dest: Float32Array, maxFrames: number, newest: boolean): number[];
  setPush(on: boolean): void;
  ack(): void;
  updateNotification(text: string): void;
  getCaptureState(): CaptureState;
  isDebug(): boolean;
  setSyntheticSource(spec: SyntheticSpec | null): Promise<void>;
  injectPcm(pcm: Float32Array): number;
  debugInterruption(began: boolean): void;
  debugStats(): MicDebugStats;
  addListener<E extends keyof NativeEvents>(event: E, listener: (payload: NativeEvents[E]) => void): Subscription;
};

const native = requireOptionalNativeModule<NativeMicPcm>('MicPcm');

/** Converts one native push payload to the contract's PcmChunk (zero-copy view on the event's ArrayBuffer). */
export function chunkFromNative(p: NativeBuffer): PcmChunk {
  const d = p.data;
  const data = ArrayBuffer.isView(d)
    ? d.byteOffset % 4 === 0
      ? new Float32Array(d.buffer, d.byteOffset, p.frames)
      : new Float32Array(d.slice().buffer, 0, p.frames)
    : new Float32Array(d, 0, p.frames);
  const chunk: PcmChunk = { data, framePos: p.framePos, tMs: p.tMs, dropped: p.dropped, sampleRate: p.sampleRate };
  if (p.discontinuity) chunk.discontinuity = true;
  return chunk;
}

/** Dev-only extras beyond the shared interface (self-test, D24). Undefined in Release builds. */
export type MicPcmDebug = {
  /** Replaces the next frames by `pcm` (at the running hardware rate); returns the framePos of its first frame. */
  injectPcm(pcm: Float32Array): number;
  /** Runs the platform's interruption path (iOS: system notification; Android: silenced capture callback). */
  interruption(began: boolean): void;
  stats(): MicDebugStats;
};

function create(n: NativeMicPcm): MicPcm & { debug?: MicPcmDebug } {
  const bufferListeners = new Set<(c: PcmChunk) => void>();
  let bufferSub: Subscription | null = null;

  const onBuffer = (p: NativeBuffer) => {
    try {
      const chunk = chunkFromNative(p);
      bufferListeners.forEach((l) => l(chunk));
    } finally {
      n.ack();
    }
  };

  const debugOn = n.isDebug();
  const api: MicPcm & { debug?: MicPcmDebug } = {
    getInfo: () => n.getInfo(),
    requestPermission: () => n.requestPermission(),
    start: (options) => n.start(options),
    stop: () => n.stop(),
    read(maxFrames, mode) {
      const dest = new Float32Array(Math.max(0, Math.floor(maxFrames)));
      const [frames, framePos, tMs, dropped, disc, sampleRate] = n.readInto(dest, dest.length, mode === 'newest');
      const chunk: PcmChunk = { data: dest.subarray(0, frames), framePos, tMs, dropped, sampleRate };
      if (disc === 1) chunk.discontinuity = true;
      return chunk;
    },
    updateNotification: (text) => n.updateNotification(text),
    addListener(event, listener) {
      if (event === 'buffer') {
        const l = listener as (c: PcmChunk) => void;
        bufferListeners.add(l);
        if (!bufferSub) {
          bufferSub = n.addListener('buffer', onBuffer);
          n.setPush(true);
        }
        return {
          remove() {
            bufferListeners.delete(l);
            if (bufferListeners.size === 0 && bufferSub) {
              n.setPush(false);
              bufferSub.remove();
              bufferSub = null;
            }
          },
        };
      }
      return n.addListener(event as Exclude<keyof NativeEvents, 'buffer'>, listener as never);
    },
    getCaptureState: () => n.getCaptureState(),
  };
  if (debugOn) {
    api.setSyntheticSource = (spec) => n.setSyntheticSource(spec);
    api.debug = {
      injectPcm: (pcm) => n.injectPcm(pcm),
      interruption: (began) => n.debugInterruption(began),
      stats: () => n.debugStats(),
    };
  }
  return api;
}

/** The native module, or null where it is not linked (Jest, web). */
export const MicPcmNative: (MicPcm & { debug?: MicPcmDebug }) | null = native ? create(native) : null;
