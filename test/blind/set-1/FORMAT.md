# Fixture format (blind oracle set for the sound-level engine)

Everything here was derived from `docs/SPEC.md` §7, `docs/FORMATS.md`, `docs/QA_SIGNALS.md` and primary standards
texts only, without reading the engine. All files are plain data; `check.py` (stdlib Python) recomputes the
expectations from the files.

## Layout
| Path | Content |
|---|---|
| `signals/Sxx_<name>.wav` | PCM fixtures, mono, IEEE float32 (WAV format tag 3, `fact` chunk), 44 100 or 48 000 Hz |
| `nights/Nxx_<name>.csv` | 8-hour 1-s series in the FORMATS.md CSV format (English variant) |
| `nights/Nxx_<name>.blocks.json` | the same series as 900-byte minute blocks (FORMATS.md backup codec) |
| `dose/Dxx_<name>.csv` | 1-s series for the dose cases (same CSV format) |
| `expected/signals.json`, `expected/nights.json`, `expected/dose.json` | expectations |
| `check.py` | recomputes everything from the files and compares (`python3 -I check.py [signals\|nights\|dose] [ids]`) |

## 1. PCM fixtures (`expected/signals.json`)
**Conventions**
- Samples are floats in [-1, 1] exactly as stored (float32). Second `i` = samples `[i*fs, (i+1)*fs)`. Feed them to the engine
  in any buffer size; the overload rule is evaluated per 100-ms buffer (`fs/10` samples, aligned to the file start).
- Levels are **dB re full scale with `offset_db = 0`** (SPEC 7.1: a full-scale sine reads -3.01). An assertion that carries
  `offset_db` is the engine output with that profile offset (E1/E2: 129.989).
- Time weighting assumes the SPEC 7.3 recursion starts from `y[-1] = 0`. Assertions that depend on that are marked
  `initial_state_assumption: true` (status UNCONFIRMED). The SPEC does not state the initial state.
- Weighting expectations use the **analog** IEC 61672-1 formula from SPEC 7.2 at the true signal frequencies. The engine's
  digital filters may deviate by the SPEC A1 amounts, and the tolerances include those amounts.

**Fixture object**: `id, name, file, fs, duration_s, signal{...exact synthesis parameters...}, note, status,
check{method}, assertions[], info{}`. `info` holds non-asserted context, e.g. `plain_bilinear_A_dB`: what an
uncorrected bilinear filter would read (so you can see which fixtures tell a corrected engine from an uncorrected one).

**Assertion object**
| Field | Meaning |
|---|---|
| `quantity` | see glossary below |
| `second` | integer = that 1-s record; `null` = file/range level |
| `range` | `[a, b)` seconds used for a range-level quantity (energy mean / max over those records) |
| `expected` | value (dB, or 0/1 for flags) |
| `tol` | pass if `abs(engine - expected) <= tol` |
| `lo`, `hi` | interval instead of `tol` (pass if `lo <= engine <= hi`) |
| `offset_db` | the engine run with this calibration offset |
| `status` | `sourced` = follows from a cited definition/standard; `UNCONFIRMED` = depends on an assumption (`basis` says which) |
| `basis` | how the value was derived |
| `missing: true` | the engine must output **no value** (empty level) |
| `nocheck: true` | check.py cannot recompute it independently (engine-side only) |
| `info_only: true` | SPEC A1 sets no limit at this frequency (16 kHz). Report it, do not gate on it |
| `iec_table: true` | compared with the rounded IEC 61672-1 Table 4 value (tolerance 0.3, SPEC A3) |
| `spec_weakness: true` | the literal SPEC rule gives a questionable result; the expected value is the literal one |
| `burst_second`, `ref_second` | for `burst_delta_*`: max in `burst_second` minus `LAeq_1s`/`LZeq_1s` of the steady `ref_second` |

**Quantity glossary**
- Per-second (the stored record, SPEC 7.4): `LAeq_1s`, `LCeq_1s`, `LZeq_1s`, `LAFmax_1s`, `LAFmin_1s`, `LAS_end` (LAS at the
  last sample of the second), `LCpeak_1s` (max |x_C|), flags `overload`, `mic_busy`, `partial`.
- Not stored, but the engine computes them (live display/unit test): `LZpeak_1s`, `LZFmax_1s`, `LZFmin_1s`, `LCS_end`,
  `LASmax` (Slow maximum).
- Range level: `LAeq`, `LCeq`, `LZeq` (energy mean of the records in `range`), `LAFmax`, `LZpeak`, `LCeq_minus_LAeq`,
  `L10`, `L50`, `L90` (SPEC 7.4 nearest rank on 0.1-dB-rounded `LAeq_1s` of all valid seconds),
  `burst_delta_AF|AS|ZF|ZS`.

**Tolerance rules used**
| Case | Tolerance |
|---|---|
| Z quantities computed from the samples (energy, peak, Z time weighting) | 0.005-0.01 dB (exact arithmetic) |
| A/C of a tone, 20 Hz-5 kHz | 0.1 dB (A1) + fractional-cycle term `10log10(1+1/(2*pi*f))` for 1-s records + 0.01 |
| A/C of a tone at 8 / 10 / 12.5 kHz | 0.6 / 1.3 / 3.0 dB (A1); 16 kHz: 7 dB, `info_only` |
| 6.3 kHz (not in A1) | not used |
| `LAFmax_1s`, `LAFmin_1s`, `LAS_end` of tones | A1 + 0.02 (+ the analytic 2f ripple of the recursion, which is part of the expected value) |
| `LCpeak_1s` | `lo` = expected - A1 - worst sampled-peak shortfall at that f/fs; `hi` = expected + A1 + 0.01; second 0 not asserted (start transient overshoots by up to 0.8 dB) |
| Pink multitone (31 one-third-octave tones) LA/LC | 0.1 dB + 0.01 (SPEC A1, sourced) |
| Dense pink noise LA/LC | 0.1 + 0.01 (A1 extended to dense pink: UNCONFIRMED) |
| White noise, clipped signals, impulse | `lo/hi` from the A1 envelope applied line by line: 0.1 to 5 kHz, 0.6 to 8 kHz, 1.3 to 10 kHz, 3.0 to 12.5 kHz, **7 dB above 12.5 kHz (UNCONFIRMED: SPEC sets no limit)** |
| Tone bursts | relative `burst_delta_A*`: 0.1 vs analytic (A3), 0.3 vs IEC Table 4; absolute burst maximum 0.2 (A1 + A3); burst-second LAeq 0.15 (UNCONFIRMED onset transients) |
| Steps (1 kHz) | 0.13 dB + ripple |
| Percentiles | level tolerance + 0.05 (0.1-dB rounding) |
| Seconds not asserted | second 0 of tones below 250 Hz and of noise (filter start transient) |

Validation done while building the set (diagnostic, not shipped): a causal, uncorrected bilinear A/C filter (Float64
biquads, as SPEC 7.2 describes) passes every assertion except the ones where SPEC A1 deliberately demands the
high-frequency correction stage. It misses pink by -0.21 dB at 48 kHz, the same figure SPEC 7.2 reports. It also
misses 8 kHz and 12.5 kHz at 44.1 kHz by more than the A1 limits. That covers 55 assertions in S15, S17, S19, S20,
S23 and S24.

## 2. Nights (`expected/nights.json`)
- CSV: UTF-8 BOM, CRLF, header `time,LAeq_1s,LCeq_1s,LZeq_1s,LAFmax,LAFmin,LAS,LCpeak,overload,partial`, 0.1-dB values,
  `time` = ISO 8601 local time with the offset of that moment (zone `tz`, Europe/Berlin). Gap seconds have **no row**.
  Mic-busy seconds (N13) have a row with **empty level cells**. The detector treats them as a gap (SPEC 7.5: flag + gap
  `mic-busy`).
- Blocks: `{sessionStartMs, blocks:[{idx, startMs, data}]}`, `data` = base64 of 60 x (7 x int16 LE tenths + flag byte).
  Missing seconds are -32768 in all 7 values with flags 0. Mic-busy seconds have flag bit 2.
- Second index `s` = (UTC ms - `start_utc_ms`)/1000. Every night has `n_seconds = 28800` (8 h).
- Night object: `id, name, status, note, csv, blocks, tz, start_utc_ms, start_local, end_local, n_seconds, sensitivity_db,
  floor_db, gaps[{start_s,end_s,start_ms,end_ms,reason}], planted[{kind,start_s,end_s,note}], expected_events{"<delta>":
  [...]}, expected_summary{...}, variant_results{...}`.
- Event object: `start_s, end_s` (end = last loud second + 1), `start_ms, end_ms, start_local, end_local, duration_s, LAeq,
  LCeq` (energy mean over every second in [start, end), quiet ones included, as SPEC E6 requires), `LAFmax, LCpeak` (max),
  `lf_hint` (LCeq - LAeq > 10), `overload_s`, `loud_s`, `merged_quiet_runs` (lengths of the quiet runs merged into it),
  `merge_decision` (text).
- Summary: `valid_s, gap_s, LAeq, L10, L50, L90, LAFmax, LCpeak, background_B` (L90 of valid seconds outside events),
  `events`, `events_22_06` (counted by local **start** time in [22:00, 06:00): UNCONFIRMED reading of SPEC 7.8).
- Tolerances: event count exact, start/end exact (SPEC A5 allows +-1 s), LAeq/LCeq 0.01 dB (A2), LAFmax/LCpeak exact
  (maxima of 0.1-dB values), flags/counts exact.

**Interpretation variants.** SPEC 7.7 leaves three points open. `check.py` runs all 8 combinations:
| Name | Values (first = primary) |
|---|---|
| window | `prev` B(t) from [t-600, t-1] / `incl` [t-599, t] |
| membership ("not inside an event") | `span` every second from an event's start to its latest loud second (quiet ones included) / `loud` only loud seconds |
| undefined B (< 60 usable seconds after the warm-up) | `none` nothing is loud / `hold` keep the last defined B |

Nights not marked UNCONFIRMED give identical events in all 8 variants and keep a margin of at least 0.3 dB to every
threshold. The exceptions are the deliberate boundary seconds, which use values like 30.0/40.0/35.0/34.9 that are
exact in binary. The UNCONFIRMED nights (N07, N08, N20) list the other variants' (start, end) pairs in
`variant_results`. Fixed for every variant: the threshold test is `>=`; quiet runs of <= 10 s merge; gaps (including
mic-busy) end an event; the first and last 10 s cannot start an event but an event may continue into them; overloaded
and partial seconds are valid; L90 nearest rank uses exact integer arithmetic on tenths.

## 3. Dose (`expected/dose.json`)
Case object: `id, name, status, note, csv, start_utc_ms, n_seconds, valid_s, segments[{seconds, LAeq_1s, LAS, LCpeak}]`
(LAeq `null` = gap), `expected{niosh_dose_pct, niosh_twa, niosh_projected_pct, osha_dose_pct, osha_twa,
osha_projected_pct, LAeq_Te, LEX_8h, LCpeak_max}` (TWA `null` when the dose is 0), `tol`, `alternative_if_other_reading`,
`reference_lines`.
- NIOSH: `T(L) = 8 h / 2^((L-85)/3)` on LAeq,1s; OSHA: `T(L) = 8 h / 2^((L-90)/5)` on LAS. A second adds `1 s / T(L)` when
  its level is >= 80.0 dB(A), otherwise 0. `D` in %; TWA per SPEC 7.6 (OSHA constant 16.61). Projected = `D * 8 h / Te`.
  `LEX,8h = LAeq,Te + 10 log10(Te / 8 h)`. Te = valid seconds (gaps excluded).
- Tolerances: dose and projected 0.01 percentage points; dB values 0.005.
