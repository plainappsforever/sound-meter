#!/usr/bin/env node
// Writes WAV test signals for the owner's side-by-side QA (SPEC §17, docs/QA_SIGNALS.md) into artifacts/test-signals/.
// Played from the Mac or a speaker — never from the measuring phone (FEATURE_LEDGER FA03). Deterministic (seeded).
// Usage: node scripts/make-test-signals.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FS = 48000;
const out = process.argv[2] ?? join(process.cwd(), 'artifacts', 'test-signals');
mkdirSync(out, { recursive: true });

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
function scaleTo(x, dbfs) {
  const g = 10 ** (dbfs / 20) / rms(x);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}
function fade(x, ms = 50) {
  const n = Math.round((ms / 1000) * FS);
  for (let i = 0; i < n && i < x.length; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

/** Pink noise: white noise (seeded) through Paul Kellet's widely used "refined" pink filter (about −3 dB/octave; designed for 44.1 kHz, close enough at 48 kHz for a QA signal). */
function pink(seconds, seed = 1) {
  const r = rng(seed);
  const n = seconds * FS;
  const x = new Float64Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return x;
}

function sine(seconds, f) {
  const x = new Float64Array(seconds * FS);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * f * i) / FS);
  return x;
}

/** 4 kHz tone bursts of 200 ms (whole cycles, from a zero crossing) every 2 s. */
function bursts(seconds) {
  const x = new Float64Array(seconds * FS);
  const len = Math.round(0.2 * 4000) * (FS / 4000);
  for (let start = FS; start + len < x.length; start += 2 * FS)
    for (let i = 0; i < len; i++) x[start + i] = Math.sin((2 * Math.PI * 4000 * i) / FS);
  return x;
}

function wav(name, x) {
  const n = x.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(FS, 24);
  buf.writeUInt32LE(FS * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(join(out, name), buf);
  console.log(`${name}  ${(n / FS).toFixed(0)} s  RMS ${(20 * Math.log10(rms(x))).toFixed(1)} dBFS`);
}

wav('pink-noise-60s.wav', fade(scaleTo(pink(60), -20)));
// Five 30-s steps of pink noise, 10 dB apart (−50 … −10 dBFS): level linearity side by side with the meter.
const steps = new Float64Array(150 * FS);
for (let k = 0; k < 5; k++) steps.set(fade(scaleTo(pink(30, 10 + k), -50 + 10 * k)), k * 30 * FS);
wav('pink-noise-steps-5x30s.wav', steps);
wav('sine-1kHz-60s.wav', fade(scaleTo(sine(60, 1000), -20)));
wav('sine-100Hz-60s.wav', fade(scaleTo(sine(60, 100), -20)));
wav('bursts-4kHz-200ms-60s.wav', bursts(60).map((v) => v * 0.1));
