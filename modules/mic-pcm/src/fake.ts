// Node fake of the MicPcm interface for Jest (no native code). Deterministic: the caller drives time with pump().
// It also models the failure cases the night log must survive: dropped frames, interruptions, route changes and the
// Android "mic busy" all-zero capture — and, since fix round 1 (review M1), wall time that moves on WITHOUT frames
// (`stall`: framePos continues, jumps or restarts, like an AVAudioEngine restart) and a rate change (`setRate`).
// Chunk times follow the PcmChunk contract: tMs = the fake's monotonic clock at the first frame.
import type { MicEvents, MicInfo, MicPcm, PcmChunk, StartOptions, StartResult, Subscription } from './MicPcm.types';

export type Generator = (framePos: number, frames: number, sampleRate: number) => Float32Array;

export type FakeMicOptions = {
  sampleRate?: number;
  generator: Generator;
  startTimeMs: number;
  info?: Partial<MicInfo>;
};

export type FakeMic = MicPcm & {
  /** Produces `seconds` of audio as chunks of bufferMs (events + ring buffer). */
  pump(seconds: number): void;
  /** Loses `frames` frames (the next chunk reports them as dropped and framePos jumps). */
  drop(frames: number): void;
  /** The next `seconds` of audio are exact zeros (Android mic taken by a call). */
  zeros(seconds: number): void;
  /**
   * `seconds` of wall time pass with NO frames (an interruption, an engine restart). framePos afterwards: 'continues'
   * (no frames counted), 'jumps' (advanced by the stalled time) or 'restarts' (back to 0). The next chunk carries
   * `discontinuity` when `flag` is true.
   */
  stall(seconds: number, framePos: 'continues' | 'jumps' | 'restarts', flag?: boolean): void;
  /** Hardware rate change from the next chunk on (with discontinuity). */
  setRate(sampleRate: number): void;
  emit<E extends keyof MicEvents>(event: E, payload: MicEvents[E]): void;
  readonly running: boolean;
};

export function createFakeMic(o: FakeMicOptions): FakeMic {
  let fs = o.sampleRate ?? 48000;
  let clockMs = 0; // monotonic time of the next frame, ms since startTimeMs
  let flagNext = false;
  const listeners = new Map<keyof MicEvents, Set<(p: unknown) => void>>();
  let running = false;
  let bufferFrames = Math.round(fs / 10);
  let ringFrames = fs * 2;
  let framePos = 0;
  let pendingDrop = 0;
  let zeroFrames = 0;
  let ring: PcmChunk[] = [];
  let readPos = 0;

  const emit = <E extends keyof MicEvents>(event: E, payload: MicEvents[E]) => listeners.get(event)?.forEach((l) => l(payload));

  const fake: FakeMic = {
    get running() {
      return running;
    },
    async getInfo() {
      return { platform: 'android', sources: ['unprocessed', 'voice_recognition', 'mic'], route: 'builtin', routes: ['builtin'], sampleRates: [fs], permission: 'granted', ...o.info };
    },
    async requestPermission() {
      return 'granted';
    },
    async start(opts: StartOptions): Promise<StartResult> {
      running = true;
      bufferFrames = Math.round((fs * (opts.bufferMs ?? 100)) / 1000);
      ringFrames = Math.round(fs * (opts.ringSeconds ?? 2));
      return { sampleRate: fs, source: 'unprocessed', route: 'builtin', framesPerBuffer: bufferFrames, processed: false };
    },
    async stop() {
      running = false;
    },
    read(maxFrames, mode) {
      const avail = ring.filter((c) => c.framePos + c.data.length > readPos);
      if (avail.length === 0) return { data: new Float32Array(0), framePos: readPos, tMs: o.startTimeMs + clockMs, dropped: 0, sampleRate: fs };
      const pick = mode === 'newest' ? avail.slice(-Math.max(1, Math.ceil(maxFrames / bufferFrames))) : avail.slice(0, Math.max(1, Math.floor(maxFrames / bufferFrames)));
      const first = pick[0];
      const dropped = mode === 'oldest' ? Math.max(0, first.framePos - readPos) : 0;
      const out = new Float32Array(pick.reduce((s, c) => s + c.data.length, 0));
      let k = 0;
      for (const c of pick) {
        out.set(c.data, k);
        k += c.data.length;
      }
      const last = pick[pick.length - 1];
      readPos = last.framePos + last.data.length;
      return { data: out, framePos: first.framePos, tMs: first.tMs, dropped, discontinuity: first.discontinuity, sampleRate: first.sampleRate };
    },
    updateNotification() {},
    addListener(event, listener): Subscription {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (p: unknown) => void);
      listeners.set(event, set);
      return { remove: () => set.delete(listener as (p: unknown) => void) };
    },
    pump(seconds: number) {
      if (!running) return;
      const total = Math.round(seconds * fs);
      for (let done = 0; done < total; done += bufferFrames) {
        const n = Math.min(bufferFrames, total - done);
        const dropped = pendingDrop;
        framePos += pendingDrop;
        clockMs += (pendingDrop * 1000) / fs;
        pendingDrop = 0;
        // the generator sees wall time (seconds since start × rate), so a script stays on the clock across stalls
        let data = o.generator(Math.round((clockMs * fs) / 1000), n, fs);
        if (zeroFrames > 0) {
          data = new Float32Array(n);
          zeroFrames -= n;
        }
        const chunk: PcmChunk = { data, framePos, tMs: o.startTimeMs + clockMs, dropped, sampleRate: fs };
        if (flagNext) chunk.discontinuity = true;
        flagNext = false;
        framePos += n;
        clockMs += (n * 1000) / fs;
        ring.push(chunk);
        while (ring.length && ring[0].framePos + ring[0].data.length < framePos - ringFrames) ring.shift();
        emit('buffer', chunk);
      }
    },
    drop(frames: number) {
      pendingDrop += frames;
    },
    zeros(seconds: number) {
      zeroFrames += Math.round(seconds * fs);
    },
    stall(seconds, mode, flag = false) {
      clockMs += seconds * 1000;
      if (mode === 'jumps') framePos += Math.round(seconds * fs);
      if (mode === 'restarts') framePos = 0;
      if (flag) flagNext = true;
    },
    setRate(sampleRate) {
      fs = sampleRate;
      bufferFrames = Math.round(fs / 10);
      flagNext = true;
    },
    emit,
  };
  // keep `ring` reachable for read(); reset on start
  const start = fake.start.bind(fake);
  fake.start = async (opts) => {
    ring = [];
    readPos = framePos;
    return start(opts);
  };
  return fake;
}
