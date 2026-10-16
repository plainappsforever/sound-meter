# In-repo oracle (Python stdlib) — weighting filters, Leq, percentiles, dose

`npm run oracle` = export the engine's filter coefficients → `weighting_oracle.py` → `levels_oracle.py` → Jest runner
`src/engine/oracle.test.ts`. Python 3 standard library only, run isolated (`python3 -I`).

| File | Checks |
|---|---|
| `iec61672_2002_table2.py` | IEC 61672-1:2002 Table 2 (A, C weightings; class 1 and class 2 tolerance limits), transcribed from IS 15575 (Part 1):2005, the identical public adoption |
| `weighting_oracle.py` | reads `data/engine-filters.json` (coefficients only) and evaluates H(e^jω) with `cmath`: (1) deviation from the Table 2 design goal vs the **class 2** limits (class 1 reported) at the 34 standard frequencies 10 Hz–20 kHz, at the exact frequencies the table is computed from; (2) error vs the analog formula with pole frequencies **derived from the standard's equations** (not the engine's constants) vs SPEC A1; (3) its own time-domain DF-II-T run of sines (whole cycles) = the response; (4) the table transcription itself: the formula rounded to 0.1 dB reproduces all 34 rows. Writes `results/weighting.json`. |
| `levels_oracle.py` | writes `expectations/levels.json`: 56 sines (20 Hz–10 kHz, 44.1/48 kHz), 6 pink multitones, 6 PCM step signals (1 kHz, LAeq + NIOSH dose from PCM), 120 random 1-s scripts (LAeq, L10/L50/L90, NIOSH/OSHA dose, TWA, projected dose, LEX,8h) — descriptions + expectations from SPEC §7 formulas |
| `src/engine/oracle.test.ts` | synthesises PCM/records from the descriptions only, runs the engine, requires 0 mismatches (levels ≤ 0.01 dB for records and PCM steps, the A1 limit for sines, 0.1 dB for pink, dose ≤ 0.01 % points) |
| `src/engine/dsp/filters-export.test.ts` | fails when `data/engine-filters.json` is stale (filter design changed without re-running the oracle) |

**Independence and its limits (L27):** the oracle never imports or reads `src/engine/`; it derives the IEC poles itself
and uses its own filter loop. But it was **written by the same agent that built the engine** in the same session, so it
is an independent *implementation*, not a *blind* set. The blind oracle of V1_PLAN P2.5 (a separate agent that never
reads the engine) is still to come; its numbers are the evidence for A2/A5.

**Measured once** against the engine snapshot commit `695ce45` (2026-10-16): see `docs/V1_LOG.md` "Oracle".
