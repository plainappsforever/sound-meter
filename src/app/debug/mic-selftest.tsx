// P3 spike self-test (dev builds only, SPEC §10 "Debug"): runs the native capture module through the real pipeline and
// shows/logs the numbers V1_LOG "P3 spike" records. Deep link: soundmeter-dev://debug/mic-selftest?run=<step>[&minutes=N]
//   run = quick (info + E1 + injected blind fixtures) | e1 | inject | interruption | lost | pull | soak | all
// Each finished step logs one line "SELFTEST {json}" (levels and delivery statistics only — never PCM, D13).
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { MicPcmNative } from '../../../modules/mic-pcm';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { upsertBlock, readRecords } from '@/db/blocks';
import { listGaps } from '@/db/gaps';
import { useSQLiteContext } from '@/db/provider';
import { createSession, heartbeat } from '@/db/sessions';
import { DEFAULT_OFFSET_DB } from '@/engine/calibration';
import { useTheme } from '@/hooks/use-theme';
import { isDevBuild } from '@/lib/debug';
import {
  captureRun,
  coverage,
  fullSecondsLaeq,
  msPerAudioSecond,
  runE1,
  runFramesLost,
  runInjected,
  runInterruption,
  runPull,
  type Probe,
} from '@/lib/mic-selftest';

type Line = { id: string; text: string; pass?: boolean };

const log = (step: string, data: unknown) => console.log(`SELFTEST ${JSON.stringify({ step, platform: Platform.OS, ...(data as object) })}`);

const probeSummary = (p: Probe) => ({
  chunks: p.chunks,
  frames: p.frames,
  minChunk: p.minChunk,
  maxChunk: p.maxChunk,
  dropped: p.dropped,
  discontinuities: p.discontinuities,
  bursts: p.bursts,
  maxJitterMs: +p.maxJitterMs.toFixed(3),
  driftPpm: +p.driftPpm.toFixed(1),
  breaks: p.breaks.slice(0, 10),
  jsMsPerAudioS: +msPerAudioSecond(p).toFixed(3),
  maxLatencyMs: +p.maxLatencyMs.toFixed(1),
  meanLatencyMs: +p.meanLatencyMs.toFixed(1),
  backgroundChunks: p.backgroundChunks,
  meanDc: p.meanDc,
});

export default function MicSelftestScreen() {
  const params = useLocalSearchParams<{ run?: string; minutes?: string }>();
  if (!isDevBuild || !MicPcmNative?.debug) {
    return <ThemedText testID="selftest-unavailable">Self-test: dev builds with the native module only.</ThemedText>;
  }
  return <Selftest run={params.run} minutes={Number(params.minutes ?? 30)} linkKey={JSON.stringify(params)} />;
}

function Selftest({ run, minutes, linkKey }: { run?: string; minutes: number; linkKey: string }) {
  const mic = MicPcmNative!;
  const db = useSQLiteContext();
  const theme = useTheme();
  const [status, setStatus] = useState('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const busy = useRef(false);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => (appState.current = s));
    return () => sub.remove();
  }, []);

  const add = useCallback((l: Line) => setLines((xs) => [...xs.filter((x) => x.id !== l.id), l]), []);

  const steps = useCallback(
    () => ({
      info: async () => {
        const perm = await mic.requestPermission();
        const info = await mic.getInfo();
        log('info', { perm, info });
        add({ id: 'info', text: `${info.platform} sources ${info.sources.join('/')} route ${info.route} rates ${info.sampleRates.join('/')} perm ${perm}` });
      },
      e1: async () => {
        const r = await runE1(mic, 6);
        const stats = mic.debug!.stats();
        log('e1', { pass: r.pass, laeq: r.laeq, lceq: r.lceq, lzeq: r.lzeq, min: r.min, max: r.max, seconds: r.seconds, start: r.run.start, probe: probeSummary(r.run.probe), gaps: r.run.gaps, events: r.run.events, native: stats });
        add({ id: 'e1', pass: r.pass, text: `E1 ${r.laeq.toFixed(2)} dB(A) C ${r.lceq.toFixed(2)} Z ${r.lzeq.toFixed(2)} ${r.pass ? 'PASS' : 'FAIL'}` });
        add({ id: 'e1-src', text: `${r.run.start.source} ${r.run.start.sampleRate} Hz ${r.run.start.route} processed ${r.run.start.processed} · JS ${msPerAudioSecond(r.run.probe).toFixed(2)} ms/s · jitter ${r.run.probe.maxJitterMs.toFixed(2)} ms` });
      },
      inject: async () => {
        const info = await mic.getInfo();
        // the running rate is only known after start; load both rates' fixtures lazily
        // __DEV__ is constant-folded by Metro: Release bundles never contain the fixture module or its WAV assets
        const loadFixtures = __DEV__
          ? // eslint-disable-next-line @typescript-eslint/no-require-imports
            (require('@/lib/selftest-fixtures') as typeof import('@/lib/selftest-fixtures')).loadFixtures
          : null;
        if (!loadFixtures) throw new Error('dev builds only');
        // with the synthetic source set, so the iOS simulator never opens its (deadlocking) input
        await mic.setSyntheticSource?.({ kind: 'zeros' });
        const probe = await mic.start({ source: 'auto' });
        await mic.stop();
        const fixtures = await loadFixtures(probe.sampleRate);
        const { start, results } = await runInjected(mic, fixtures);
        const mism = results.reduce((s, r) => s + r.mismatches, 0);
        const s01 = results.find((r) => r.id === 'S01' || r.id === 'S02');
        const e1 = s01 ? fullSecondsLaeq(s01.records).laeq + DEFAULT_OFFSET_DB : NaN;
        const pass = mism === 0 && results.length > 0 && Math.abs(e1 - 94) <= 0.05;
        for (const r of results) log('inject', { id: r.id, fs: r.fs, skipped: r.skipped, mismatches: r.mismatches, frames: r.frames, jsMsPerS: r.jsMsPerS, records: r.records });
        log('inject-summary', { pass, fixtures: results.map((r) => r.id), mismatches: mism, e1, start, info });
        add({ id: 'inject', pass, text: `Injected ${results.length} blind fixtures at ${start.sampleRate} Hz · mismatched samples ${mism} · E1 ${e1.toFixed(3)} dB ${pass ? 'PASS' : 'FAIL'}` });
      },
      interruption: async () => {
        const r = await runInterruption(mic);
        log('interruption', { pass: r.pass, detail: r.detail, gaps: r.run.gaps, events: r.run.events, probe: probeSummary(r.run.probe), native: mic.debug!.stats() });
        add({ id: 'interruption', pass: r.pass, text: `Interruption: ${r.detail} ${r.pass ? 'PASS' : 'FAIL'}` });
      },
      lost: async () => {
        const r = await runFramesLost(mic);
        log('lost', { pass: r.pass, detail: r.detail, gaps: r.run.gaps, probe: probeSummary(r.run.probe), native: mic.debug!.stats() });
        add({ id: 'lost', pass: r.pass, text: `Frames lost: ${r.detail} ${r.pass ? 'PASS' : 'FAIL'}` });
      },
      pull: async () => {
        const oldest = await runPull(mic, 'oldest', 9600, 10, 6);
        const newest = await runPull(mic, 'newest', 4096, 30, 6);
        log('pull', { oldest, newest });
        add({ id: 'pull', text: `read oldest ${oldest.msPerCall.toFixed(3)} ms/call (${oldest.frames}/${oldest.expectedFrames} frames, dropped ${oldest.dropped}) · newest 4096 ${newest.msPerCall.toFixed(3)} ms/call` });
      },
      listen: async () => {
        // 60 s of plain capture (synthetic 1 kHz at −60 dBFS) for EXTERNAL events: emulator phone call, route change
        const r = await captureRun(mic, { synthetic: { kind: 'sine', hz: 1000, rmsDbfs: -60 }, seconds: 60, start: { background: true } });
        await mic.setSyntheticSource?.(null);
        const busy = r.records.filter((x) => (x.flags & 4) !== 0).length;
        log('listen', { gaps: r.gaps, events: r.events, micBusySeconds: busy, records: r.records.length, probe: probeSummary(r.probe), native: mic.debug!.stats() });
        add({ id: 'listen', text: `Listen 60 s: events ${r.events.map((e) => e.type).join(', ') || 'none'} · gaps ${r.gaps.map((g) => `${g.reason} ${((g.endMs - g.startMs) / 1000).toFixed(1)} s`).join(', ') || 'none'} · mic-busy s ${busy}` });
      },
      realinput: async () => {
        // the real microphone, no synthetic source (P3 diagnostics; on the iOS simulator this may abort the app)
        await mic.setSyntheticSource?.(null);
        const r = await captureRun(mic, { seconds: 4, start: { debugPlainMode: Platform.OS === 'ios' } as never });
        const a = fullSecondsLaeq(r.records);
        log('realinput', { start: r.start, laeq: a.laeq, probe: probeSummary(r.probe), events: r.events, native: mic.debug!.stats() });
        add({ id: 'realinput', text: `Real input ${r.start.source} ${r.start.sampleRate} Hz: LAeq ${a.laeq.toFixed(1)} (uncalibrated host mic) · chunks ${r.probe.chunks}` });
      },
      soak: async () => {
        const startedAt = Date.now();
        const id = await createSession(db, {
          caseId: null, kind: 'log', title: `P3 soak ${Platform.OS}`, place: '', operator: '', note: 'P3 spike (synthetic source)',
          startedAt, tzName: 'UTC', tzOffsetMin: 0, profileName: 'default', offsetDb: DEFAULT_OFFSET_DB,
          calibMethod: 'platform-default', calibratedAt: null, referenceMeter: '', deviceModel: Platform.OS,
          osVersion: String(Platform.Version), audioSource: Platform.OS === 'ios' ? 'ios_measurement' : 'voice_recognition',
          sampleRate: 48000, appVersion: 'dev', sensitivity: 'normal',
        });
        let lastBeat = 0;
        let lastNote = 0;
        const writes: Promise<void>[] = [];
        // night-like script: 50 s quiet (−95 dBFS ≈ 35 dB), 10 s louder (−65 dBFS ≈ 65 dB)
        const r = await captureRun(mic, {
          synthetic: { kind: 'script', loop: true, steps: [{ seconds: 50, rmsDbfs: -95 }, { seconds: 10, rmsDbfs: -65, hz: 500 }] },
          seconds: minutes * 60,
          // 30-s ring: a JS stall shorter than that costs nothing (soak 2 on iOS lost 0.6 s after a 13.5-s stall with 10 s)
          start: { background: true, ringSeconds: 30, notification: { title: 'Decibel', text: 'P3 soak', stopLabel: 'Stop' } },
          isBackground: () => appState.current !== 'active',
          onBlock: (b) => writes.push(upsertBlock(db, id, b)),
          onTick: (elapsed, pipe) => {
            if (elapsed - lastBeat >= 60) {
              lastBeat = elapsed;
              writes.push(heartbeat(db, id, Date.now()));
              const p = pipe.pendingBlock();
              if (p) writes.push(upsertBlock(db, id, p));
            }
            if (elapsed - lastNote >= 30) {
              lastNote = elapsed;
              mic.updateNotification(`Logging noise · ${pipe.live().las.toFixed(0)} dB(A) · ${Math.floor(elapsed / 60)} min`);
            }
          },
          onProgress: (elapsed, probe) => {
            if (Math.floor(elapsed) % 15 === 0) setStatus(`soak ${Math.floor(elapsed)} / ${minutes * 60} s · chunks ${probe.chunks} · bg ${probe.backgroundChunks}`);
          },
        });
        await Promise.all(writes);
        const stored = await readRecords(db, id);
        const gaps = await listGaps(db, id);
        const cov = coverage(stored, r.gaps, r.sessionStartMs, r.endMs);
        const pass = cov.pct >= 99.5 && r.gaps.length === 0;
        log('soak', { pass, minutes, sessionId: id, coverage: cov, storedRecords: stored.length, dbGaps: gaps, pipelineGaps: r.gaps, events: r.events, probe: probeSummary(r.probe), native: mic.debug!.stats() });
        add({ id: 'soak', pass, text: `Soak ${minutes} min: ${cov.storedS}/${cov.expectedS} s stored (${cov.pct.toFixed(2)} %) · gaps ${r.gaps.length} · bg chunks ${r.probe.backgroundChunks} · JS ${msPerAudioSecond(r.probe).toFixed(2)} ms/s ${pass ? 'PASS' : 'FAIL'}` });
      },
    }),
    [add, db, mic, minutes]
  );

  const runSteps = useCallback(
    async (names: string[]) => {
      if (busy.current) return;
      busy.current = true;
      const all = steps() as Record<string, () => Promise<void>>;
      try {
        for (const n of names) {
          setStatus(`running ${n}`);
          try {
            await all[n]();
          } catch (e) {
            log('error', { step: n, message: String(e) });
            add({ id: n, pass: false, text: `${n}: ERROR ${String(e)}` });
            await mic.stop().catch(() => {});
          }
        }
        setStatus('done');
        log('done', { steps: names });
      } finally {
        busy.current = false;
      }
    },
    [add, mic, steps]
  );

  useEffect(() => {
    const plans: Record<string, string[]> = {
      quick: ['info', 'e1', 'inject'],
      all: ['info', 'e1', 'inject', 'interruption', 'lost', 'pull'],
      e1: ['info', 'e1'],
      inject: ['info', 'inject'],
      interruption: ['info', 'interruption'],
      lost: ['info', 'lost'],
      pull: ['info', 'pull'],
      soak: ['info', 'soak'],
      realinput: ['info', 'realinput'],
      listen: ['info', 'listen'],
    };
    // A fast refresh remounts this screen with the same params: never re-run a link that was already handled.
    const g = globalThis as { __micSelftestHandled?: Set<string> };
    const handled = (g.__micSelftestHandled ??= new Set<string>());
    if (run && plans[run] && !handled.has(linkKey)) {
      handled.add(linkKey);
      runSteps(plans[run]);
    }
  }, [run, linkKey, runSteps]);

  const buttons = ['quick', 'all', 'interruption', 'lost', 'pull', 'soak'];
  return (
    <>
      <Stack.Screen options={{ title: 'Mic self-test' }} />
      <ScrollView testID="selftest-screen" style={{ backgroundColor: theme.background }} contentContainerStyle={styles.content}>
        <ThemedText testID="selftest-status">{status}</ThemedText>
        <View style={styles.row}>
          {buttons.map((b) => (
            <Pressable key={b} testID={`selftest-run-${b}`} onPress={() => runSteps(b === 'quick' ? ['info', 'e1', 'inject'] : b === 'all' ? ['info', 'e1', 'inject', 'interruption', 'lost', 'pull'] : ['info', b])} style={styles.button}>
              <ThemedText themeColor="tint">{b}</ThemedText>
            </Pressable>
          ))}
        </View>
        {lines.map((l) => (
          <ThemedText key={l.id} testID={`selftest-${l.id}`}>
            {l.text}
          </ThemedText>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.two },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  button: { paddingVertical: Spacing.one, paddingHorizontal: Spacing.two },
});
