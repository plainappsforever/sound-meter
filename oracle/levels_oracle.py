#!/usr/bin/env python3
"""Independent oracle for levels, percentiles and dose (Python stdlib only; never reads src/engine code).

Writes oracle/expectations/levels.json: signal DESCRIPTIONS plus expected values computed here from SPEC §7 formulas
(analog IEC weighting with poles derived from the standard's equations, energy means, nearest-rank percentiles,
NIOSH/OSHA dose and TWA, EU LEX,8h). The Jest runner src/engine/oracle.test.ts synthesises the PCM / 1-s records from
the descriptions, runs the engine and compares (levels within 0.01 dB, dose within 0.01 % points, unless a case says
otherwise). Deterministic: random.Random(seed).

Case kinds:
  sine        - one sine (fs, f, rms dBFS, seconds, offset): expected LZeq/LAeq/LCeq of the steady seconds.
  multitone   - 30 equal-amplitude third-octave tones with random phases: expected LAeq/LCeq (A1: 0.1 dB).
  pcm_steps   - 1 kHz tone in steps of whole seconds: expected session LAeq and NIOSH dose from PCM.
  script      - 1-s record scripts (level per second): LAeq, L10/L50/L90, NIOSH and OSHA dose/TWA/projected, LEX,8h.
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from weighting_oracle import analog_db  # noqa: E402  (same independent formula, derived poles)

OFFSET = 94 - 20 * math.log10(520 / 32768)  # Android CDD 5.11 nominal, SPEC §7.1


def energy_mean(levels, weights=None):
    if not levels:
        return None
    weights = weights or [1] * len(levels)
    return 10 * math.log10(sum(w * 10 ** (l / 10) for l, w in zip(levels, weights)) / sum(weights))


def round1(v):
    """0.1 dB, half away from zero (SPEC §7.9)."""
    return math.copysign(math.floor(abs(v) * 10 + 0.5), v) / 10


def ln(values, n):
    v = sorted(round1(x) for x in values)
    idx = max(0, math.ceil((100 - n) / 100 * len(v)) - 1)
    return v[min(idx, len(v) - 1)]


def dose(levels, criterion, exchange, threshold=80.0):
    d = sum(1 / (8 * 3600 / 2 ** ((l - criterion) / exchange)) for l in levels if l >= threshold)
    return 100 * d


def main():
    rnd = random.Random(20261016)
    cases = []

    # sines at exact third-octave frequencies 20 Hz - 10 kHz, both rates
    for fs in (44100, 48000):
        for n in range(13, 41):
            f = 10 ** (n / 10)
            rms = rnd.uniform(-60, -10)
            la, lc = analog_db('A', f), analog_db('C', f)
            tol = 0.1 if f <= 5100 else 0.6 if f <= 8000 else 1.3
            cases.append({'kind': 'sine', 'id': f'sine-{fs}-{n}', 'fs': fs, 'f': f, 'rmsDbfs': rms, 'seconds': 4,
                          'offsetDb': OFFSET, 'expect': {'lzeq': rms + OFFSET, 'laeq': rms + OFFSET + la, 'lceq': rms + OFFSET + lc},
                          'tolDb': tol})

    # pink multitones (A1: within 0.1 dB of analytic)
    for fs in (44100, 48000):
        for seed in range(3):
            total = rnd.uniform(-40, -15)
            amp = math.sqrt(2) * 10 ** (total / 20) / math.sqrt(30)
            tones = [{'f': 10 ** (n / 10), 'amplitude': amp, 'phase': rnd.uniform(0, 2 * math.pi)} for n in range(13, 43)]
            ms = lambda w: sum(t['amplitude'] ** 2 / 2 * 10 ** (analog_db(w, t['f']) / 10) for t in tones)
            cases.append({'kind': 'multitone', 'id': f'pink-{fs}-{seed}', 'fs': fs, 'tones': tones, 'seconds': 5, 'offsetDb': 0,
                          'expect': {'laeq': 10 * math.log10(ms('A')), 'lceq': 10 * math.log10(ms('C')),
                                     'lzeq': 10 * math.log10(sum(t['amplitude'] ** 2 / 2 for t in tones))}, 'tolDb': 0.1})

    # PCM steps: 1 kHz tone, whole-second steps, Leq + NIOSH dose computed from PCM by the engine
    for k in range(6):
        steps = [{'seconds': rnd.randint(2, 20), 'db': round(rnd.uniform(70, 105), 1)} for _ in range(rnd.randint(2, 5))]
        secs, lv = [], []
        for s in steps:
            secs += [1] * s['seconds']
            lv += [s['db']] * s['seconds']
        cases.append({'kind': 'pcm_steps', 'id': f'pcm-steps-{k}', 'fs': 48000, 'f': 1000, 'offsetDb': OFFSET, 'steps': steps,
                      'expect': {'laeq': energy_mean(lv), 'nioshPct': dose(lv, 85, 3)}, 'tolDb': 0.02, 'tolPct': 0.05})

    # record scripts: random nights/workdays at 0.1-dB resolution
    for k in range(120):
        segs = []
        for _ in range(rnd.randint(1, 8)):
            segs.append({'seconds': rnd.randint(1, 1800), 'db': round1(rnd.uniform(25, 115)), 'jitter': rnd.random() < 0.5})
        levels = []
        for s in segs:
            for i in range(s['seconds']):
                # description rule (the Jest runner expands it the same way): with jitter, second i of a segment is
                # round1(db + (((i * 7) % 19) - 9) / 10), so percentiles see many different values
                levels.append(round1(s['db'] + (((i * 7) % 19) - 9) / 10 if s['jitter'] else s['db']))
        te = len(levels)
        laeq = energy_mean(levels)
        n_pct = dose(levels, 85, 3)
        o_pct = dose(levels, 90, 5)
        cases.append({'kind': 'script', 'id': f'script-{k}', 'segments': segs, 'expect': {
            'laeq': laeq, 'l10': ln(levels, 10), 'l50': ln(levels, 50), 'l90': ln(levels, 90),
            'nioshPct': n_pct, 'nioshTwa': (10 * math.log10(n_pct / 100) + 85) if n_pct > 0 else None,
            'nioshProjectedPct': n_pct * 8 * 3600 / te,
            'oshaPct': o_pct, 'oshaTwa': (16.61 * math.log10(o_pct / 100) + 90) if o_pct > 0 else None,
            'lex8h': laeq + 10 * math.log10(te / (8 * 3600)),
        }, 'tolDb': 0.01, 'tolPct': 0.01})

    out = {'generatedBy': 'oracle/levels_oracle.py', 'seed': 20261016, 'offsetDb': OFFSET, 'cases': cases}
    path = os.path.join(HERE, 'expectations', 'levels.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(out, fh)
        fh.write('\n')
    counts = {}
    for c in cases:
        counts[c['kind']] = counts.get(c['kind'], 0) + 1
    print('wrote', os.path.relpath(path, os.path.dirname(HERE)), counts)
    return 0


if __name__ == '__main__':
    sys.exit(main())
