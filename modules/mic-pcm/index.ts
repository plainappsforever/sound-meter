// modules/mic-pcm — shared microphone PCM capture (sound-meter + tuner-metronome). API: src/MicPcm.types.ts.
export * from './src/MicPcm.types';
export { MicPcmNative, chunkFromNative, type MicDebugStats, type MicPcmDebug } from './src/MicPcmModule';
