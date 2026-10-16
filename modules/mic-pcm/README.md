# modules/mic-pcm — shared microphone PCM capture (Swift + Kotlin, P3)

Local Expo module (`expo-module.config.json`, autolinked). Typed API and the TIMING CONTRACT: `src/MicPcm.types.ts`
(pure types — the tuner can copy it as is). JS wrapper: `src/MicPcmModule.ts` → `MicPcmNative` (null where the native
module is not linked, e.g. Jest; use `src/fake.ts` there). Written for two apps (sound-meter D12/D28,
`~/Developer/tuner-metronome` P3/P6, read-only coordination).

Privacy rule for both apps: **no function writes audio anywhere** (file, database, log). PCM lives in the native ring
buffer and in the JS chunk being processed. `src/no-audio.test.ts` scans the TS API and every native source (A12).

## What the native side does
| | iOS (`ios/MicCapture.swift`) | Android (`android/…/MicCore.kt`) |
|---|---|---|
| Session / source | `AVAudioSession` `.record` (or `.playAndRecord` with `category`) + mode `.measurement`; built-in mic preferred | `AudioRecord` UNPROCESSED (if `PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED`) → VOICE_RECOGNITION (→ MIC on request); `setPreferredDevice(TYPE_BUILTIN_MIC)`; AGC/NS/AEC switched off when attached |
| Format | `AVAudioEngine` input tap at the hardware rate, first channel, Float32 | 48 kHz (44.1 fallback), `PCM_FLOAT` (PCM_16 → float fallback), mono |
| Capture time `tMs` | tap `AVAudioTime.hostTime` (mach ticks → ms via `mach_timebase_info`) + one epoch offset taken at `start()` | `getTimestamp(TIMEBASE_MONOTONIC)` extrapolated to the first frame of each read on the sample clock + one epoch offset; fallback (counted in `debug.stats().tsFallback`): read time − buffer length |
| `framePos` | frames written to the ring since it was created: continues across interruptions/restarts | same (resets only with a new `start()`) |
| `discontinuity` | first frame after start, engine restart (interruption end, `AVAudioEngineConfigurationChange`, media reset) and any jump of the tap's `sampleTime` | first frame after start |
| Interruptions | `interruptionNotification` → `interruption` event; restart on `ended` | `AudioRecordingCallback.isClientSilenced` (API 29+) → `interruption` event; the silenced stretch is zeros (engine flags mic-busy) |
| Routes | `routeChangeNotification` → `route` event, built-in re-preferred | `OnRoutingChangedListener` → `route` event |
| Background | `UIBackgroundModes: audio` (app plugin) | `MicCaptureService` — foreground service type microphone with an ongoing notification + Stop (`stopRequested` event). **Registered by the app's plugin** (`plugins/with-mic-fgs.js`), not by the module manifest, so the tuner does not inherit a Play FGS declaration |

## Delivery
- **Push** (`addListener('buffer', …)`): one event per tap/read (~100 ms; ≤ 1 s when catching up). The wrapper calls
  the native `ack()` after the listeners ran; at most 4 events are unacknowledged. While JS is stalled the native side
  stops sending, the ring keeps filling and finally overwrites; the next chunk reports the loss in `dropped`
  (`framePos` jumps by exactly that amount). Payload: iOS `Data` → `Uint8Array`, Android `NativeArrayBuffer` →
  `ArrayBuffer`; the wrapper makes a zero-copy `Float32Array` view. (A Swift `NativeArrayBuffer` inside a `sendEvent`
  dictionary arrived EMPTY on SDK 57 — measured in P3.)
- **Pull** `read(maxFrames, 'oldest' | 'newest')`: synchronous JSI call writing into a fresh `Float32Array`
  (native `readInto(dest, maxFrames, newest)`). 'oldest' = next contiguous frames (meter); 'newest' = the latest
  `maxFrames` frames, older ones skipped and counted in `dropped` (tuner `readInput`). Push and pull have separate
  cursors. A chunk never spans a discontinuity or a rate change.
- **Important for screen-off use (P3, D19):** drive processing from push events. React Native's JS timers are not
  guaranteed to fire with the screen off (Android: Choreographer), events from native are.

## Dev builds only (`debug` member, `setSyntheticSource`)
`isDebug()` gates them (iOS `#if DEBUG`, Android `FLAG_DEBUGGABLE`); the wrapper leaves them undefined otherwise.
- `setSyntheticSource(spec)` replaces the microphone samples in the capture callback (sine, multitone, burst, silence
  = uniform noise at an RMS, zeros, script). Synthesis index follows the device sample clock and re-syncs to wall time
  at each discontinuity.
- `debug.injectPcm(pcm)` replaces the next frames by `pcm` (at the running hardware rate) and returns the `framePos` of
  its first frame — used to push blind-set fixtures through ring + transfer + engine.
- `debug.interruption(began)` runs the platform's own interruption path (iOS: stops the engine and posts the system
  notification; Android: zeros + the silenced-client handler). `debug.stats()` = delivery statistics.
- **iOS simulator:** on this Mac the simulator's audio server deadlocks in AudioUnit Initialize as soon as an IO unit
  with input is opened ("Initialize: RPC timeout. Apparently deadlocked. Aborting now." — the app is killed). With a
  synthetic source set, the simulator therefore never opens the input: frames come from the host clock
  (`mach_absolute_time`), and a silent output-only engine (category `.playback`, mixable) keeps the audio session —
  and the background-audio process — alive. Real-input capture on iOS is device-only (`debug.stats().clockMode`).

## Not implemented (D19 fallback, only if needed)
`startLevels` / `levels` events and `processFixture` (native per-second levels). The P3 spike decides; see
`docs/V1_LOG.md` "P3 spike" and DECISIONS D31.

Attribution: loop/engine structure adapted from expo-audio's `AudioStream.swift` / `AudioStream.kt` (MIT,
© 650 Industries); timing, ring buffer, interruption handling, FGS and the synthetic source are new.
