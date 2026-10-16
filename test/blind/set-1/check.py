#!/usr/bin/env python3
"""Blind oracle check: recompute the expectations from the fixture files themselves.

Run from anywhere (Python 3.9+, standard library only):
    python3 -I check.py            # everything (signals take a few minutes in pure Python)
    python3 -I check.py signals    # or: nights | dose
    python3 -I check.py signals S07 S08   # only these fixture ids

What it does
  signals: reads every WAV, recomputes per-second Z levels, Z time weighting, peaks, overload/mic-busy/partial flags
           exactly from the samples; recomputes A/C levels from the samples either by measuring the tone frequency
           (single-tone fixtures: frequency from the spectrum, gain from the IEC 61672-1 analog formula, then the
           SPEC 7.3 recursion on the scaled samples) or by a frequency-domain weighting of the stationary part
           (noise, multitone, clipped).  Every assertion in expected/signals.json is compared.
  nights:  parses every night CSV (UTF-8 BOM, CRLF, ISO local time with offset -> UTC), checks it against the
           900-byte block file, runs the SPEC 7.7 detector (primary interpretation + 7 variants) and the SPEC 7.4
           metrics, compares with expected/nights.json.
  dose:    parses every dose CSV and recomputes NIOSH/OSHA/EU values, compares with expected/dose.json.
Exit code 0 = no mismatch.
"""
import array
import base64
import bisect
import cmath
import datetime
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- weighting (SPEC 7.2 / IEC 61672-1 Annex E)
F1, F2, F3, F4 = 20.598997, 107.65265, 737.86223, 12194.217


def _ra(f):
    f2 = f * f
    return F4 ** 2 * f2 * f2 / ((f2 + F1 ** 2) * math.sqrt((f2 + F2 ** 2) * (f2 + F3 ** 2)) * (f2 + F4 ** 2))


def _rc(f):
    f2 = f * f
    return F4 ** 2 * f2 / ((f2 + F1 ** 2) * (f2 + F4 ** 2))


_RA1K, _RC1K = _ra(1000.0), _rc(1000.0)


def gain(weighting, f):
    """Amplitude gain of the analog weighting at f (Hz), normalised to 1 at 1 kHz."""
    if weighting == 'Z':
        return 1.0
    if f <= 0:
        return 0.0
    return _ra(f) / _RA1K if weighting == 'A' else _rc(f) / _RC1K


def L(v):
    return 10.0 * math.log10(v) if v > 0 else float('-inf')


# ---------------------------------------------------------------- mixed-radix FFT (pure Python)
def fft(x):
    n = len(x)
    if n == 1:
        return [complex(x[0])]
    p = next((q for q in (2, 3, 5, 7, 11, 13) if n % q == 0), None)
    if p is None:  # naive DFT for other primes
        return [sum(x[j] * cmath.exp(-2j * math.pi * j * k / n) for j in range(n)) for k in range(n)]
    m = n // p
    subs = [fft(x[r::p]) for r in range(p)]
    out = [0j] * n
    if p == 2:
        s0, s1 = subs
        for k in range(m):
            t = s1[k] * cmath.exp(-2j * math.pi * k / n)
            out[k] = s0[k] + t
            out[k + m] = s0[k] - t
        return out
    rp = [cmath.exp(-2j * math.pi * q / p) for q in range(p)]
    for k in range(m):
        t = [subs[r][k] * cmath.exp(-2j * math.pi * r * k / n) for r in range(p)]
        for q in range(p):
            out[k + q * m] = sum(t[r] * rp[(r * q) % p] for r in range(p))
    return out


# ---------------------------------------------------------------- WAV
def read_wav(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE', path
    pos, fmt, samples = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b'fmt ':
            tag, ch, fs, _, _, bits = struct.unpack('<HHIIHH', body[:16])
            fmt = (tag, ch, fs, bits)
        elif cid == b'data':
            tag, ch, fs, bits = fmt
            if tag == 3 and bits == 32:
                a = array.array('f')
                a.frombytes(body)
            elif tag == 1 and bits == 16:
                a = array.array('h')
                a.frombytes(body)
                a = [v / 32768.0 for v in a]
            else:
                raise ValueError('unsupported WAV format %r' % (fmt,))
            if sys.byteorder != 'little' and isinstance(a, array.array):
                a.byteswap()
            samples = list(a)[::ch]
        pos += 8 + size + (size & 1)
    return fmt[2], samples


# ---------------------------------------------------------------- per-second analysis (SPEC 7.3-7.5)
def overload_in(seg):
    """SPEC 7.5: any |x| >= 0.999, or >= 4 consecutive equal samples with |x| >= 0.5."""
    run, prev = 0, None
    for v in seg:
        a = abs(v)
        if a >= 0.999:
            return True
        if a >= 0.5 and v == prev:
            run += 1
            if run >= 4:
                return True
        else:
            run = 1 if a >= 0.5 else 0
        prev = v
    return False


def analyse(x, fs, gain_scale=None, prefix='Z'):
    """Per-second records of signal x (optionally multiplied by a scalar weighting gain)."""
    aF = 1 - math.exp(-1.0 / (fs * 0.125))
    aS = 1 - math.exp(-1.0 / (fs * 1.0))
    g2 = 1.0 if gain_scale is None else gain_scale * gain_scale
    yF = yS = 0.0
    out = []
    nsec = -(-len(x) // fs)
    for i in range(nsec):
        seg = x[i * fs:(i + 1) * fs]
        ss = 0.0
        fmax, fmin, smax = -1.0, float('inf'), -1.0
        for v in seg:
            e = v * v * g2
            ss += e
            yF += aF * (e - yF)
            yS += aS * (e - yS)
            if yF > fmax:
                fmax = yF
            if yF < fmin:
                fmin = yF
            if yS > smax:
                smax = yS
        rec = {
            prefix + 'eq_1s': L(ss / len(seg)),
            prefix + 'Fmax_1s': L(fmax), prefix + 'Fmin_1s': L(fmin), prefix + 'S_end': L(yS), prefix + 'Smax_1s': L(smax),
            prefix + 'peak_1s': 20 * math.log10(max(abs(v) for v in seg) * math.sqrt(g2)) if any(seg) else float('-inf'),
        }
        if gain_scale is None:
            ovl = any(overload_in(seg[b:b + fs // 10]) for b in range(0, len(seg), fs // 10))
            rec.update({'overload': int(ovl), 'mic_busy': int(all(v == 0.0 for v in seg)),
                        'partial': int(len(seg) < 0.9 * fs), '_ms': ss / len(seg), '_n': len(seg)})
        out.append(rec)
    return out


def tone_frequency(x, fs, s0, nsec=1):
    """Frequency of the dominant tone in seconds [s0, s0+nsec): Blackman-Harris spectrum + parabolic peak."""
    seg = x[s0 * fs:(s0 + nsec) * fs]
    n = len(seg)
    a0, a1, a2, a3 = 0.35875, 0.48829, 0.14128, 0.01168
    w = [a0 - a1 * math.cos(2 * math.pi * k / n) + a2 * math.cos(4 * math.pi * k / n) - a3 * math.cos(6 * math.pi * k / n)
         for k in range(n)]
    X = fft([seg[k] * w[k] for k in range(n)])
    mag = [abs(v) for v in X[:n // 2]]
    k = max(range(1, n // 2 - 1), key=lambda j: mag[j])
    la, lb, lc = (math.log(max(mag[k + d], 1e-300)) for d in (-1, 0, 1))
    delta = 0.5 * (la - lc) / (la - 2 * lb + lc) if (la - 2 * lb + lc) != 0 else 0.0
    return (k + delta) * fs / n


def spectral_ratio(x, fs, s0, s1, window):
    """Weighted/unweighted energy ratio (A and C) of seconds [s0, s1) via the analog formula on the spectrum."""
    seg = x[s0 * fs:s1 * fs]
    n = len(seg)
    if window == 'bh':
        a0, a1, a2, a3 = 0.35875, 0.48829, 0.14128, 0.01168
        seg = [seg[k] * (a0 - a1 * math.cos(2 * math.pi * k / n) + a2 * math.cos(4 * math.pi * k / n)
                         - a3 * math.cos(6 * math.pi * k / n)) for k in range(n)]
    X = fft(seg)
    tot = wa = wc = 0.0
    for k in range(0, n // 2 + 1):
        p = abs(X[k]) ** 2 * (1 if k in (0, n // 2) else 2)
        f = k * fs / n
        tot += p
        wa += p * gain('A', f) ** 2
        wc += p * gain('C', f) ** 2
    return wa / tot, wc / tot


def percentile(vals_tenths, N):
    """SPEC 7.4 nearest rank on 0.1-dB values, exact integer arithmetic: v[ceil((100-N)/100*n) - 1]."""
    v = sorted(vals_tenths)
    n = len(v)
    idx = max(0, -(-(100 - N) * n // 100) - 1)
    return v[idx]


def r10(x):
    """Round to tenths, half away from zero (SPEC 7.9), as an int."""
    return int(math.floor(abs(x) * 10 + 0.5)) * (1 if x >= 0 else -1)


# ---------------------------------------------------------------- signal check
def measure_signal(fx):
    fs, x = read_wav(os.path.join(HERE, fx['file']))
    assert fs == fx['fs'], (fx['id'], fs)
    m = {'Z': analyse(x, fs)}
    meth = fx['check']['method']
    nsec = len(m['Z'])
    sec = [dict(r) for r in m['Z']]
    filelev = {}
    if meth == 'tone':
        f_est = tone_frequency(x, fs, fx['check']['tone_second'], fx['check'].get('tone_seconds', 1))
        filelev['tone_f_Hz'] = f_est
        for w in ('A', 'C'):
            g = gain(w, f_est)
            for i, r in enumerate(analyse(x, fs, gain_scale=g, prefix=w)):
                sec[i].update(r)
    elif meth == 'spectral':
        s0, s1 = fx['check']['range']
        ra, rc = spectral_ratio(x, fs, s0, s1, fx['check']['window'])
        filelev['ratio_A_dB'], filelev['ratio_C_dB'] = L(ra), L(rc)
        for i, r in enumerate(sec):
            if r['_ms'] > 0:
                r['Aeq_1s'] = r['Zeq_1s'] + L(ra)
                r['Ceq_1s'] = r['Zeq_1s'] + L(rc)
    # file-level over a range of whole seconds
    def energy_mean(key, a, b):
        vals = [10 ** (sec[i][key] / 10) for i in range(a, b) if key in sec[i] and sec[i][key] != float('-inf')]
        return L(sum(vals) / len(vals)) if vals else None
    out = {}
    for a in fx['assertions']:
        q, i = a['quantity'], a.get('second')
        key = {'LAeq_1s': 'Aeq_1s', 'LCeq_1s': 'Ceq_1s', 'LZeq_1s': 'Zeq_1s', 'LAFmax_1s': 'AFmax_1s',
               'LAFmin_1s': 'AFmin_1s', 'LAS_end': 'AS_end', 'LCpeak_1s': 'Cpeak_1s', 'LZpeak_1s': 'Zpeak_1s',
               'LZFmax_1s': 'ZFmax_1s', 'LZFmin_1s': 'ZFmin_1s', 'LZS_end': 'ZS_end', 'LCFmax_1s': 'CFmax_1s',
               'LCS_end': 'CS_end', 'overload': 'overload', 'mic_busy': 'mic_busy', 'partial': 'partial'}.get(q)
        if i is not None and key is not None:
            out[(q, i)] = sec[i].get(key)
            continue
        rng = a.get('range', [0, nsec])
        valid = [j for j in range(*rng) if not sec[j]['mic_busy']]
        if q in ('LAeq', 'LCeq', 'LZeq'):
            out[(q, None)] = energy_mean(q[1] + 'eq_1s', *rng)
        elif q in ('LAFmax', 'LZFmax', 'LCFmax'):
            k = q[1] + 'Fmax_1s'
            vals = [sec[j][k] for j in valid if k in sec[j]]
            out[(q, None)] = max(vals) if vals else None
        elif q in ('LASmax', 'LZSmax'):
            k = q[1] + 'Smax_1s'
            vals = [sec[j][k] for j in valid if k in sec[j]]
            out[(q, None)] = max(vals) if vals else None
        elif q in ('LCpeak', 'LZpeak'):
            k = q[1] + 'peak_1s'
            vals = [sec[j][k] for j in valid if k in sec[j]]
            out[(q, None)] = max(vals) if vals else None
        elif q in ('L10', 'L50', 'L90'):
            vals = [r10(sec[j]['Aeq_1s']) for j in valid if 'Aeq_1s' in sec[j]]
            out[(q, None)] = percentile(vals, int(q[1:])) / 10 if len(vals) == len(valid) and vals else None
        elif q == 'LCeq_minus_LAeq':
            c, aa = energy_mean('Ceq_1s', *rng), energy_mean('Aeq_1s', *rng)
            out[(q, None)] = None if c is None or aa is None else c - aa
        elif q in ('burst_delta_AF', 'burst_delta_AS', 'burst_delta_ZF', 'burst_delta_ZS'):
            w, tw = q[-2], q[-1]
            bs, ref = a['burst_second'], a['ref_second']
            burst = sec[bs][w + ('Fmax_1s' if tw == 'F' else 'Smax_1s')]
            refv = sec[ref][w + 'eq_1s']
            out[(q, None)] = burst - refv
        elif q == 'tone_f_Hz':
            out[(q, None)] = filelev.get('tone_f_Hz')
    return out


def cmp(expected, measured, a):
    if measured is None:
        return None
    if isinstance(expected, (int, float)) and expected in (float('inf'), float('-inf')):
        return measured == expected
    if 'lo' in a or 'hi' in a:
        return a.get('lo', -1e9) - 1e-9 <= measured <= a.get('hi', 1e9) + 1e-9
    tol = a.get('check_tol', a.get('tol', 0))
    return abs(measured - expected) <= tol + 1e-9


def check_signals(only):
    fixtures = json.load(open(os.path.join(HERE, 'expected', 'signals.json')))['fixtures']
    bad = n = skipped = 0
    for fx in fixtures:
        if only and fx['id'] not in only:
            continue
        meas = measure_signal(fx)
        fails = []
        for a in fx['assertions']:
            if a.get('nocheck'):
                skipped += 1
                continue
            mv = meas.get((a['quantity'], a.get('second')))
            exp = a.get('expected')
            if a.get('missing'):
                ok = mv is None or mv == float('-inf')
            else:
                if mv is not None:
                    mv = mv + a.get('offset_db', 0.0)
                ok = cmp(exp if exp is not None else 0, mv, a)
            if ok is None:
                skipped += 1
                continue
            n += 1
            if not ok:
                fails.append('%s[%s] expected %s (tol %s / lo %s hi %s) measured %s' % (
                    a['quantity'], a.get('second'), exp, a.get('check_tol', a.get('tol')), a.get('lo'), a.get('hi'), mv))
        bad += len(fails)
        print('%-4s %-34s %s' % (fx['id'], fx['name'], 'ok' if not fails else 'MISMATCH'))
        for f in fails:
            print('       ' + f)
    print('signals: %d assertions compared, %d mismatches, %d not recomputable here (engine-only)' % (n, bad, skipped))
    return bad


# ---------------------------------------------------------------- nights (FORMATS.md CSV + block codec)
COLS = ['LAeq_1s', 'LCeq_1s', 'LZeq_1s', 'LAFmax', 'LAFmin', 'LAS', 'LCpeak']


def parse_iso(s):
    return datetime.datetime.fromisoformat(s)


def read_series_csv(path, start_ms, n):
    """Returns list of n entries: None (no row = gap) or dict of tenths ints (None = empty cell) + flags."""
    with open(path, 'rb') as fh:
        raw = fh.read()
    assert raw[:3] == b'\xef\xbb\xbf', 'missing UTF-8 BOM'
    text = raw[3:].decode('utf-8')
    assert '\r\n' in text and '\n' not in text.replace('\r\n', ''), 'line ends must be CRLF'
    lines = text.split('\r\n')
    assert lines[0] == 'time,' + ','.join(COLS) + ',overload,partial', lines[0]
    series = [None] * n
    for ln in lines[1:]:
        if not ln:
            continue
        p = ln.split(',')
        t = parse_iso(p[0])
        i = int(round((t.timestamp() * 1000 - start_ms) / 1000))
        rec = {c: (None if p[k + 1] == '' else int(round(float(p[k + 1]) * 10))) for k, c in enumerate(COLS)}
        rec['overload'], rec['partial'] = int(p[8]), int(p[9])
        series[i] = rec
    return series


def read_blocks(path, n):
    j = json.load(open(path))
    series = [None] * n
    for b in j['blocks']:
        data = base64.b64decode(b['data'])
        assert len(data) == 900
        for r in range(60):
            vals = struct.unpack('<7hB', data[r * 15:(r + 1) * 15])
            i = b['idx'] * 60 + r
            if i >= n:
                continue
            if all(v == -32768 for v in vals[:7]) and not (vals[7] & 4):
                series[i] = None
            else:
                rec = {c: (None if vals[k] == -32768 else vals[k]) for k, c in enumerate(COLS)}
                rec['overload'], rec['partial'], rec['mic_busy'] = vals[7] & 1, (vals[7] >> 1) & 1, (vals[7] >> 2) & 1
                series[i] = rec
    return series


def valid(r):
    return r is not None and r.get('LAeq_1s') is not None


VARIANTS = [(w, m, u) for w in ('prev', 'incl') for m in ('span', 'loud') for u in ('none', 'hold')]
PRIMARY = ('prev', 'span', 'none')


def detect(series, delta_db, variant=PRIMARY, floor_db=35.0):
    """SPEC 7.7 on 0.1-dB integer values. variant = (window, membership, undefined-background):
       window 'prev' = B(t) from seconds [t-600, t-1]; 'incl' = [t-599, t]
       membership 'span' = every second from an event's first to its latest loud second is 'inside an event';
                  'loud' = only loud seconds are
       undefined 'none' = fewer than 60 usable seconds -> no loud seconds; 'hold' = keep the last defined B."""
    win, member, undef = variant
    n = len(series)
    d10, floor10 = int(round(delta_db * 10)), int(round(floor_db * 10))
    inev = [False] * n
    inwin = [False] * n
    window = []  # sorted LAeq values of the usable seconds currently in the 600-s window

    def add(s):
        if 0 <= s < n and not inwin[s] and not inev[s] and valid(series[s]):
            bisect.insort(window, series[s]['LAeq_1s'])
            inwin[s] = True

    def rem(s):
        if 0 <= s < n and inwin[s]:
            window.pop(bisect.bisect_left(window, series[s]['LAeq_1s']))
            inwin[s] = False

    def mark(s):
        inev[s] = True
        rem(s)

    events, cur, lastB = [], None, None
    Bs = [None] * n
    for t in range(n):
        if win == 'prev':  # window [t-600, t-1]
            add(t - 1)
            rem(t - 601)
        else:  # window [t-599, t]
            add(t)
            rem(t - 600)
        r = series[t]
        if not valid(r):
            if cur:
                events.append(cur)
                cur = None
            continue
        if cur and t - cur[1] - 1 > 10:
            events.append(cur)
            cur = None
        k = len(window)
        if k >= 60:
            B = window[max(0, -(-10 * k // 100) - 1)]  # L90, exact integer nearest rank
            lastB = B
        else:
            B = lastB if undef == 'hold' else None
        Bs[t] = B
        lmax = r['LAFmax']
        loud = B is not None and lmax is not None and lmax >= B + d10 and lmax >= floor10
        if not loud:
            continue
        if cur and t - cur[1] - 1 <= 10:
            if member == 'span':
                for s_ in range(cur[1] + 1, t + 1):
                    mark(s_)
            else:
                mark(t)
            cur[1] = t
            cur[2] += 1
            cur[3].append(t - cur[4] - 1)
            cur[4] = t
        else:
            if cur:
                events.append(cur)
                cur = None
            if t < 10 or t >= n - 10:
                continue
            mark(t)
            cur = [t, t, 1, [], t]  # start, last loud, loud count, quiet runs merged, prev loud
    if cur:
        events.append(cur)
    return [{'start_s': e[0], 'end_s': e[1] + 1, 'loud_s': e[2], 'merged_quiet_runs': e[3]} for e in events], Bs


def emean(vals10):
    return L(sum(10 ** (v / 100) for v in vals10) / len(vals10))


def event_metrics(series, ev):
    rs = [series[s] for s in range(ev['start_s'], ev['end_s']) if valid(series[s])]
    la = emean([r['LAeq_1s'] for r in rs])
    lc = emean([r['LCeq_1s'] for r in rs])
    return {'LAeq': la, 'LCeq': lc, 'LAFmax': max(r['LAFmax'] for r in rs) / 10,
            'LCpeak': max(r['LCpeak'] for r in rs) / 10, 'lf_hint': int(lc - la > 10),
            'overload_s': sum(r['overload'] for r in rs), 'duration_s': ev['end_s'] - ev['start_s']}


def session_summary(series, events, start_ms, tzname):
    import zoneinfo
    z = zoneinfo.ZoneInfo(tzname)
    v = [r for r in series if valid(r)]
    inside = set()
    for e in events:
        inside.update(range(e['start_s'], e['end_s']))
    bg = [series[s]['LAeq_1s'] for s in range(len(series)) if valid(series[s]) and s not in inside]
    la = [r['LAeq_1s'] for r in v]
    n2206 = 0
    for e in events:
        h = datetime.datetime.fromtimestamp((start_ms + e['start_s'] * 1000) / 1000, z).hour
        n2206 += int(h >= 22 or h < 6)
    return {'valid_s': len(v), 'gap_s': len(series) - len(v), 'LAeq': emean(la), 'L10': percentile(la, 10) / 10,
            'L50': percentile(la, 50) / 10, 'L90': percentile(la, 90) / 10,
            'LAFmax': max(r['LAFmax'] for r in v) / 10, 'LCpeak': max(r['LCpeak'] for r in v) / 10,
            'background_B': percentile(bg, 90) / 10 if bg else None, 'events': len(events),
            'events_22_06': n2206}


def check_nights(only):
    spec = json.load(open(os.path.join(HERE, 'expected', 'nights.json')))
    bad = 0
    for nt in spec['nights']:
        if only and nt['id'] not in only:
            continue
        n = nt['n_seconds']
        s_csv = read_series_csv(os.path.join(HERE, nt['csv']), nt['start_utc_ms'], n)
        s_blk = read_blocks(os.path.join(HERE, nt['blocks']), n)
        fails = []
        for i in range(n):
            a, b = s_csv[i], s_blk[i]
            if (a is None) != (b is None) or (a and any(a[c] != b[c] for c in COLS + ['overload', 'partial'])):
                fails.append('CSV and block file differ at second %d' % i)
                break
        for sens, exp_list in nt['expected_events'].items():
            got, _ = detect(s_csv, float(sens), PRIMARY)
            if len(got) != len(exp_list):
                fails.append('delta %s: %d events, expected %d' % (sens, len(got), len(exp_list)))
                continue
            for g, e in zip(got, exp_list):
                gm = event_metrics(s_csv, g)
                if g['start_s'] != e['start_s'] or g['end_s'] != e['end_s']:
                    fails.append('delta %s: event %s-%s expected %s-%s' % (sens, g['start_s'], g['end_s'], e['start_s'], e['end_s']))
                for k in ('LAeq', 'LCeq', 'LAFmax', 'LCpeak'):
                    if abs(gm[k] - e[k]) > 0.005:
                        fails.append('delta %s event %s: %s %.3f expected %.3f' % (sens, e['start_s'], k, gm[k], e[k]))
                for k in ('lf_hint', 'overload_s', 'duration_s'):
                    if gm[k] != e[k]:
                        fails.append('delta %s event %s: %s %s expected %s' % (sens, e['start_s'], k, gm[k], e[k]))
            if sens == str(nt['sensitivity_db']):
                summ = session_summary(s_csv, got, nt['start_utc_ms'], nt['tz'])
                for k, v in nt['expected_summary'].items():
                    gv = summ[k]
                    if (isinstance(v, float) and abs(gv - v) > 0.005) or (not isinstance(v, float) and gv != v):
                        fails.append('summary %s %s expected %s' % (k, gv, v))
        # interpretation variants
        sens = nt['sensitivity_db']
        base = [(e['start_s'], e['end_s']) for e in nt['expected_events'][str(sens)]]
        diff = {}
        for var in VARIANTS:
            got = [(e['start_s'], e['end_s']) for e in detect(s_csv, sens, var)[0]]
            if got != base:
                diff['/'.join(var)] = got
        declared = {k: [tuple(x) for x in v] for k, v in nt.get('variant_results', {}).items()}
        if diff != declared:
            fails.append('interpretation variants differ from the declared ones: %s' % sorted(set(diff) ^ set(declared)))
        bad += len(fails)
        print('%-4s %-34s %s%s' % (nt['id'], nt['name'], 'ok' if not fails else 'MISMATCH',
                                   '  (variant-sensitive: %d of 8 variants differ)' % len(diff) if diff else ''))
        for f in fails[:10]:
            print('       ' + f)
    print('nights: %d mismatches' % bad)
    return bad


# ---------------------------------------------------------------- dose (SPEC 7.6)
def check_dose(only):
    spec = json.load(open(os.path.join(HERE, 'expected', 'dose.json')))
    bad = 0
    for c in spec['cases']:
        if only and c['id'] not in only:
            continue
        s = read_series_csv(os.path.join(HERE, c['csv']), c['start_utc_ms'], c['n_seconds'])
        v = [r for r in s if valid(r)]
        dn = sum(100.0 / (28800 / 2 ** ((r['LAeq_1s'] / 10 - 85) / 3)) for r in v if r['LAeq_1s'] >= 800)
        do = sum(100.0 / (28800 / 2 ** ((r['LAS'] / 10 - 90) / 5)) for r in v if r['LAS'] >= 800)
        te = len(v)
        laeq = emean([r['LAeq_1s'] for r in v])
        got = {'niosh_dose_pct': dn, 'niosh_twa': 10 * math.log10(dn / 100) + 85 if dn > 0 else None,
               'niosh_projected_pct': dn * 28800 / te, 'osha_dose_pct': do,
               'osha_twa': 16.61 * math.log10(do / 100) + 90 if do > 0 else None,
               'osha_projected_pct': do * 28800 / te, 'LAeq_Te': laeq, 'LEX_8h': laeq + 10 * math.log10(te / 28800),
               'LCpeak_max': max(r['LCpeak'] for r in v) / 10}
        fails = []
        for k, e in c['expected'].items():
            g = got[k]
            if e is None or g is None:
                if e != g:
                    fails.append('%s %s expected %s' % (k, g, e))
                continue
            tol = c['tol'].get(k, 0.005)
            if abs(g - e) > tol:
                fails.append('%s %.4f expected %.4f (tol %s)' % (k, g, e, tol))
        bad += len(fails)
        print('%-4s %-34s %s' % (c['id'], c['name'], 'ok' if not fails else 'MISMATCH'))
        for f in fails:
            print('       ' + f)
    print('dose: %d mismatches' % bad)
    return bad


if __name__ == '__main__':
    args = sys.argv[1:]
    part = args[0] if args and args[0] in ('signals', 'nights', 'dose', 'all') else 'all'
    only = set(a for a in args if a not in ('signals', 'nights', 'dose', 'all'))
    bad = 0
    if part in ('signals', 'all'):
        bad += check_signals(only)
    if part in ('nights', 'all'):
        bad += check_nights(only)
    if part in ('dose', 'all'):
        bad += check_dose(only)
    print('TOTAL MISMATCHES: %d' % bad)
    sys.exit(1 if bad else 0)
