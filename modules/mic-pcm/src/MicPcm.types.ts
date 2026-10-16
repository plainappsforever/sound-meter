// Shared microphone-PCM capture API — DRAFT typed interface (P1/P2), implemented natively in P3.
// Written to serve BOTH apps (D12, D28): this sound meter (continuous, every frame, background night log) and
// ~/Developer/tuner-metronome (`readInput(maxFrames)` newest frames for pitch detection, `.playAndRecord` with its
// metronome). Pure types, no imports, no native code — the tuner can copy this file as is.
//
// Hard rule of this module: it delivers PCM to JS in memory only. It has NO function that writes audio to a file, a
// database or a log (sound-meter SPEC §3.5, D13; the tuner's privacy rule is the same).

/** Android: AudioRecord sources in preference order; iOS: AVAudioSession mode `.measurement`. */
export type CaptureSource = 'unprocessed' | 'voice_recognition' | 'mic' | 'ios_measurement';
export type InputRoute = 'builtin' | 'wired' | 'bluetooth' | 'usb' | 'other';
export type PermissionState = 'granted' | 'denied' | 'undetermined';

export type MicInfo = {
  platform: 'ios' | 'android';
  /** Sources this device offers (Android: UNPROCESSED only if PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED is set). */
  sources: CaptureSource[];
  route: InputRoute;
  routes: InputRoute[];
  sampleRates: number[];
  permission: PermissionState;
};

export type StartOptions = {
  /** 'auto' = UNPROCESSED → VOICE_RECOGNITION → MIC on Android, `.measurement` on iOS. */
  source?: 'auto' | CaptureSource;
  /** Preferred rate (default 48000). The hardware rate is used when it differs (no resampling); see StartResult. */
  sampleRate?: number;
  /** Size of one delivered chunk in ms (default 100). */
  bufferMs?: number;
  /** Seconds of PCM the native ring buffer holds for `read()` (default 2 for the tuner; the meter asks for 10). */
  ringSeconds?: number;
  /** iOS category: 'record' (meter) or 'playAndRecord' (tuner + metronome). Default 'record'. */
  category?: 'record' | 'playAndRecord';
  /** Keep capturing with the screen off: iOS `UIBackgroundModes: audio`; Android microphone foreground service. */
  background?: boolean;
  /** Android foreground-service notification (required when background is true on Android). */
  notification?: { title: string; text: string; stopLabel: string };
  /** Prefer the built-in microphone even when a headset is connected (default true). */
  preferBuiltIn?: boolean;
};

export type StartResult = {
  sampleRate: number;
  source: CaptureSource;
  route: InputRoute;
  framesPerBuffer: number;
  /** True when the platform applies AGC/noise suppression we could not switch off (Android MIC fallback). */
  processed: boolean;
};

/**
 * One piece of mono PCM — the TIMING CONTRACT (fix round 1, review M1). Native code must deliver exactly this:
 * - `tMs` = capture time of the FIRST frame on the MONOTONIC clock — iOS: the tap's `AVAudioTime.hostTime`
 *   (mach_absolute_time); Android: `AudioRecord.getTimestamp(…, TIMEBASE_MONOTONIC)` extrapolated to `framePos` —
 *   converted to epoch ms with ONE offset taken at start() (epoch − monotonic). Never the time the event was sent or
 *   `read()` was called (a backlog read after the app was paused would then carry wrong times).
 * - `framePos` counts frames on the device sample clock. It advances by `data.length` from chunk to chunk inside a
 *   frame burst. It is NOT a clock: across an interruption, engine/AudioRecord restart, route or format change it may
 *   continue, jump or restart. Consumers never derive wall time from it alone.
 * - `dropped` > 0: frames lost from the ring since the previous chunk (framePos jumped by that amount).
 * - `discontinuity: true` on the first chunk after anything that may break the stream (interruption end, restart,
 *   route change, format change). Optional: the pipeline also detects breaks itself (below).
 * - `sampleRate` = hardware rate of these frames; a change is a format change.
 * Consumer side (src/lib/capture.ts): a FRAME BURST = consecutive chunks with contiguous framePos, dropped 0, no
 * discontinuity, the same rate, and tMs within 1 s of the burst's prediction. Time is anchored ONCE per burst on the
 * first chunk's tMs; inside the burst frame times are anchor.tMs + (framePos − anchor.framePos)·1000/sampleRate.
 * Within a burst a difference of 50 ms … 1 s between tMs and that prediction is sample-clock drift: the anchor moves,
 * no hole. A new burst that starts later than the audio already accounted for is a hole: the meter restarts, and the
 * part not covered by another gap becomes a `frames-lost` gap. Frames before the session start or already covered
 * are dropped.
 */
export type PcmChunk = {
  data: Float32Array;
  framePos: number;
  tMs: number;
  dropped: number;
  discontinuity?: boolean;
  sampleRate: number;
};

/** D19 fallback: one second of levels computed natively by a port of src/engine/dsp (same fields as SecondRecord). */
export type NativeSecondRecord = {
  tMs: number;
  laeq: number;
  lceq: number;
  lzeq: number;
  lafmax: number;
  lafmin: number;
  las: number;
  lcpeak: number;
  /** Bit 0 overload, bit 1 partial, bit 2 mic busy. */
  flags: number;
};

/** D19 fallback: capture + per-second levels natively; the same timing contract (bursts, restart after a hole). */
export type LevelsOptions = StartOptions & {
  offsetDb: number;
  /** Grid origin of the records (sessions.started_at). */
  sessionStartMs: number;
};

/** What runs right now (review S8: recovery asks this before trusting the heartbeat age). */
export type CaptureState = { running: boolean; mode: 'pcm' | 'levels' | null; startedAtMs: number | null };

export type MicErrorCode = 'permission-denied' | 'mic-busy' | 'start-failed' | 'source-unavailable' | 'internal';

export type MicEvents = {
  /** Push delivery (one chunk per bufferMs). Whether typed arrays in Expo module events are cheap is UNVERIFIED (P3). */
  buffer: PcmChunk;
  interruption: { phase: 'began' | 'ended'; reason: 'call' | 'siri' | 'other-app' | 'system' | 'unknown' };
  route: { route: InputRoute; builtin: boolean };
  /** Android: the user tapped Stop in the foreground-service notification. */
  stopRequested: Record<string, never>;
  error: { code: MicErrorCode; message: string };
  /** D19 fallback only: completed seconds from `startLevels` (oldest first). */
  levels: { records: NativeSecondRecord[] };
  /** Hardware rate changed (route change to Bluetooth HFP etc.); the next chunk has `discontinuity` and the new rate. */
  format: { sampleRate: number };
};

/** Dev builds only (D24): replaces the microphone with a deterministic signal at the same point of the pipeline. */
export type SyntheticSpec =
  | { kind: 'sine'; hz: number; rmsDbfs: number }
  | { kind: 'multitone'; tones: { hz: number; rmsDbfs: number }[] }
  | { kind: 'burst'; hz: number; rmsDbfs: number; burstMs: number; everyMs: number }
  | { kind: 'silence'; rmsDbfs: number }
  | { kind: 'zeros' }
  | { kind: 'script'; steps: { seconds: number; rmsDbfs: number; hz?: number }[]; loop?: boolean };

export type Subscription = { remove(): void };

export interface MicPcm {
  getInfo(): Promise<MicInfo>;
  /** Shows the system prompt (only after the user tapped "Allow microphone"). */
  requestPermission(): Promise<PermissionState>;
  start(options: StartOptions): Promise<StartResult>;
  stop(): Promise<void>;
  /**
   * Pull delivery (synchronous, from the native ring buffer).
   * 'oldest' (meter): the next contiguous frames after the last read, up to maxFrames; `dropped` > 0 if the ring
   * overflowed since. 'newest' (tuner `readInput`): the latest maxFrames frames, skipping older ones.
   */
  read(maxFrames: number, mode: 'oldest' | 'newest'): PcmChunk;
  /** Android: updates the foreground-service notification text ("Logging noise · 41 dB(A) · 2 h 13 min"). iOS: no-op. */
  updateNotification(text: string): void;
  addListener<E extends keyof MicEvents>(event: E, listener: (payload: MicEvents[E]) => void): Subscription;
  /** Dev builds only; undefined in preview/production. */
  setSyntheticSource?: (spec: SyntheticSpec | null) => Promise<void>;
  /** Is capture running in this process / its foreground service (review S8)? */
  getCaptureState?: () => CaptureState;
  /**
   * D19 fallback (only if the P3 spike shows JS does not run reliably with the screen off): capture AND compute the
   * per-second records natively; records arrive as `levels` events. Never delivers or stores PCM.
   */
  startLevels?: (options: LevelsOptions) => Promise<StartResult>;
  /**
   * D19 parity check (debug builds): runs the native DSP over a PCM fixture in memory, `bufferFrames` per call, and
   * returns its records; Jest compares them with the TS engine (must agree within 0.05 dB, SPEC §8).
   */
  processFixture?: (pcm: Float32Array, sampleRate: number, offsetDb: number, bufferFrames?: number) => Promise<NativeSecondRecord[]>;
}
