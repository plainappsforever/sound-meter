#!/usr/bin/env python3
"""Independent oracle for the A/C weighting filters (Python stdlib only; never imports or reads src/engine code).

It reads only the exported coefficients (oracle/data/engine-filters.json, written by
src/engine/dsp/filters-export.test.ts) and checks them against:
  1. IEC 61672-1:2002 Table 2 design goals with the CLASS 2 (and, for information, class 1) tolerance limits at the
     34 nominal frequencies 10 Hz - 20 kHz, evaluated at the exact base-10 frequencies the table was computed from.
  2. The analog IEC formula with pole frequencies DERIVED here from the standard's equations (5.4.6, 5.4.9 - 5.4.11:
     fL = 10^1.5, fH = 10^3.9, D^2 = 1/2, fA = 10^2.45) - not the engine's constants - against SPEC A1's limits.
  3. A time-domain run: sines through the exported sections with this file's own DF-II-T loop; the steady-state level
     must equal the frequency-response evaluation (catches coefficient-ordering mistakes).
Exit status 1 on any failure. Results: oracle/results/weighting.json.
"""
import cmath
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from iec61672_2002_table2 import TABLE2  # noqa: E402

# --- 2. pole frequencies from the standard's equations -----------------------------------------------------------
FR = 1000.0
FL = 10 ** 1.5
FH = 10 ** 3.9
D = math.sqrt(0.5)
FA = 10 ** 2.45
_b = (1 / (1 - D)) * (FR ** 2 + FL ** 2 * FH ** 2 / FR ** 2 - D * (FL ** 2 + FH ** 2))
_c = FL ** 2 * FH ** 2
F1 = math.sqrt((-_b - math.sqrt(_b ** 2 - 4 * _c)) / 2)
F4 = math.sqrt((-_b + math.sqrt(_b ** 2 - 4 * _c)) / 2)
F2 = (3 - math.sqrt(5)) / 2 * FA
F3 = (3 + math.sqrt(5)) / 2 * FA


def analog_db(w, f):
    f2 = f * f
    if w == 'C':
        r = lambda x: F4 ** 2 * x * x / ((x * x + F1 ** 2) * (x * x + F4 ** 2))
    else:
        r = lambda x: F4 ** 2 * x ** 4 / ((x * x + F1 ** 2) * math.sqrt((x * x + F2 ** 2) * (x * x + F3 ** 2)) * (x * x + F4 ** 2))
    del f2
    return 20 * math.log10(r(f) / r(1000.0))


def digital_db(filt, f, fs):
    z1 = cmath.exp(-1j * 2 * math.pi * f / fs)
    h = complex(filt['gain'])
    for b0, b1, b2, a1, a2 in filt['sections']:
        h *= (b0 + b1 * z1 + b2 * z1 * z1) / (1 + a1 * z1 + a2 * z1 * z1)
    return 20 * math.log10(abs(h))


def time_domain_db(filt, f, fs, seconds=1.0, settle=0.5):
    """Steady-state gain of a sine through the sections (own DF-II-T loop), measured over whole cycles only."""
    k0 = int(round(settle * fs))
    cycles = max(1, round(seconds * f))
    n = k0 + int(round(cycles / f * fs))
    st = [[0.0, 0.0] for _ in filt['sections']]
    e_in = e_out = 0.0
    w = 2 * math.pi * f / fs
    g = filt['gain']
    for i in range(n):
        x = math.sin(w * i)
        v = x * g
        for s, (b0, b1, b2, a1, a2) in enumerate(filt['sections']):
            y = b0 * v + st[s][0]
            st[s][0] = b1 * v - a1 * y + st[s][1]
            st[s][1] = b2 * v - a2 * y
            v = y
        if i >= k0:
            e_in += x * x
            e_out += v * v
    return 10 * math.log10(e_out / e_in)


def a1_limit(f):
    """SPEC A1: <= 0.1 dB 20 Hz - 5 kHz, 0.6 at 8 kHz, 1.3 at 10 kHz, 3 at 12.5 kHz; others reported only."""
    if 19.9 <= f <= 5100:
        return 0.1
    if 5100 < f <= 8000:
        return 0.6
    if 8000 < f <= 10100:
        return 1.3
    if 10100 < f <= 12700:
        return 3.0
    return None


def main():
    data = json.load(open(os.path.join(HERE, 'data', 'engine-filters.json')))
    failures = []
    report = {'poles': {'f1': F1, 'f2': F2, 'f3': F3, 'f4': F4}, 'table_transcription': [], 'rates': {}}

    # Table transcription check: the formula (derived poles) rounded to 0.1 dB must give every Table 2 value.
    for idx, (fnom, a_nom, c_nom, *_lims) in enumerate(TABLE2):
        f = FR * 10 ** (0.1 * (idx + 10 - 30))
        a_r, c_r = round(analog_db('A', f) + 1e-9, 1), round(analog_db('C', f) + 1e-9, 1)
        ok = abs(a_r - a_nom) < 1e-6 and abs(c_r - c_nom) < 1e-6
        report['table_transcription'].append({'f': fnom, 'A': a_r, 'C': c_r, 'ok': ok})
        if not ok:
            failures.append(f'table/formula mismatch at {fnom} Hz: formula A {a_r} C {c_r}, table A {a_nom} C {c_nom}')

    for fs_s, filters in data['filters'].items():
        fs = int(fs_s)
        rows = []
        for w in ('A', 'C'):
            filt = filters[w]
            for idx, (fnom, a_nom, c_nom, c1u, c1l, c2u, c2l) in enumerate(TABLE2):
                f = FR * 10 ** (0.1 * (idx + 10 - 30))
                if f >= fs / 2:
                    continue
                d = digital_db(filt, f, fs)
                nominal = a_nom if w == 'A' else c_nom
                dev = d - nominal
                in2 = dev <= c2u + 1e-9 and (c2l is None or dev >= c2l - 1e-9)
                in1 = dev <= c1u + 1e-9 and (c1l is None or dev >= c1l - 1e-9)
                margin2 = min(c2u - dev, (dev - c2l) if c2l is not None else math.inf)
                err_formula = d - analog_db(w, f)
                lim = a1_limit(f)
                a1_ok = lim is None or abs(err_formula) <= lim
                rows.append({'w': w, 'f_nominal': fnom, 'f_exact': f, 'digital_db': round(d, 4), 'table_db': nominal,
                             'dev_vs_table': round(dev, 4), 'class2': in2, 'class2_margin_db': round(margin2, 3),
                             'class1': in1, 'err_vs_formula': round(err_formula, 4), 'a1_limit': lim, 'a1_ok': a1_ok})
                if not in2:
                    failures.append(f'{fs} Hz {w} {fnom} Hz: deviation {dev:+.3f} dB outside class 2 [{c2l}, +{c2u}]')
                if not a1_ok:
                    failures.append(f'{fs} Hz {w} {fnom} Hz: {err_formula:+.4f} dB vs formula exceeds A1 {lim}')
            # time domain at a few frequencies
            for f in (31.6227766, 100.0, 1000.0, 3981.0717, 7943.2823, 12589.254):
                td = time_domain_db(filt, f, fs)
                fd = digital_db(filt, f, fs)
                rows.append({'w': w, 'time_domain_f': f, 'time_domain_db': round(td, 4), 'freq_domain_db': round(fd, 4)})
                if abs(td - fd) > 0.01:
                    failures.append(f'{fs} Hz {w} {f:.1f} Hz: time-domain {td:.4f} vs response {fd:.4f}')
        resp = [r for r in rows if 'class2' in r]
        report['rates'][fs_s] = {
            'rows': rows,
            'class2_all_pass': all(r['class2'] for r in resp),
            'class1_all_pass': all(r['class1'] for r in resp),
            'min_class2_margin_db': min(r['class2_margin_db'] for r in resp),
            'max_abs_dev_vs_table_db_20Hz_12k5': max(abs(r['dev_vs_table']) for r in resp if 19.9 <= r['f_exact'] <= 12700),
            'max_abs_err_vs_formula_db_20Hz_12k5': max(abs(r['err_vs_formula']) for r in resp if 19.9 <= r['f_exact'] <= 12700),
        }

    report['failures'] = failures
    os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
    with open(os.path.join(HERE, 'results', 'weighting.json'), 'w') as fh:
        json.dump(report, fh, indent=1)
        fh.write('\n')
    print(f'derived poles: f1 {F1:.6f}  f2 {F2:.5f}  f3 {F3:.5f}  f4 {F4:.3f} Hz')
    print(f'table transcription vs formula: {sum(r["ok"] for r in report["table_transcription"])}/{len(TABLE2)} rows agree')
    for fs_s, r in report['rates'].items():
        print(f'fs {fs_s}: class 2 all pass = {r["class2_all_pass"]}, class 1 all pass = {r["class1_all_pass"]}, '
              f'min class-2 margin {r["min_class2_margin_db"]:.2f} dB, max |dev vs table| 20 Hz-12.5 kHz '
              f'{r["max_abs_dev_vs_table_db_20Hz_12k5"]:.3f} dB, max |err vs formula| {r["max_abs_err_vs_formula_db_20Hz_12k5"]:.4f} dB')
    for f in failures:
        print('FAIL', f)
    print('RESULT', 'FAIL' if failures else 'PASS')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
