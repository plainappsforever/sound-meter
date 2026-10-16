/**
 * @jest-environment node
 */
import { calibrate, DEFAULT_OFFSET_DB, platformDefault, validManualOffset } from './calibration';
import { allowedSeconds, dose, doseFromLevels, lex8h } from './dose';
import { FLAG_MIC_BUSY, FLAG_OVERLOAD } from './dsp/meter';
import { aggregate, backgroundL90, energyMean, energyMeanWeighted, lfHint, percentileLN, round1 } from './levels';
import { recordsFromScript } from './signals';

const T0 = Date.UTC(2026, 9, 16, 22, 0, 0);

describe('E3 / E9 Leq', () => {
  it('E3: 30 s at 60.0 + 30 s at 70.0 → LAeq,60s = 67.40', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 30, db: 60 },
      { seconds: 30, db: 70 },
    ]);
    expect(aggregate(recs).laeq.toFixed(2)).toBe('67.40');
  });

  it('E9: eight 1-h LAeq values 30, 30, 32, 45, 30, 31, 30, 50 → LAeq,8h = 42.38', () => {
    const hours = [30, 30, 32, 45, 30, 31, 30, 50];
    expect(energyMean(hours).toFixed(2)).toBe('42.38');
    expect(energyMeanWeighted(hours.map((level) => ({ level, seconds: 3600 }))).toFixed(2)).toBe('42.38');
    const recs = recordsFromScript(
      T0,
      hours.map((db) => ({ seconds: 3600, db }))
    );
    expect(aggregate(recs).laeq.toFixed(2)).toBe('42.38');
  });

  it('energy mean is numerically stable for very high and very low levels', () => {
    expect(energyMean([150, 150])).toBeCloseTo(150, 10);
    expect(energyMean([-150, -150])).toBeCloseTo(-150, 10);
    expect(Number.isNaN(energyMean([]))).toBe(true);
  });
});

describe('E7 percentiles', () => {
  it('values 30, 31, …, 39 → L90 30, L50 34, L10 38 (nearest rank)', () => {
    const v = Array.from({ length: 10 }, (_, i) => 30 + i);
    expect(percentileLN(v, 90)).toBe(30);
    expect(percentileLN(v, 50)).toBe(34);
    expect(percentileLN(v, 10)).toBe(38);
  });

  it('works at 0.1-dB resolution, clamps the index, ignores order', () => {
    expect(percentileLN([40.04, 39.96], 90)).toBe(40);
    expect(percentileLN([55], 90)).toBe(55);
    expect(percentileLN([3, 1, 2], 100)).toBe(1);
    expect(round1(-0.05)).toBe(-0.1);
    expect(round1(0.05)).toBe(0.1);
    expect(round1(12.34)).toBe(12.3);
  });
});

describe('aggregate', () => {
  it('excludes gaps, mic-busy seconds; counts overloads; reports LF hint (WHO: > 10 dB)', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 10, db: 40, lc: 52 },
      { seconds: 5, db: 90, flags: FLAG_OVERLOAD, lc: 95 },
      { seconds: 5, db: 0, flags: FLAG_MIC_BUSY },
      { seconds: 10, db: 80 },
    ]);
    recs.filter((r) => r.flags & FLAG_MIC_BUSY).forEach((r) => (r.laeq = NaN));
    const gaps = [{ startMs: T0 + 20_000, endMs: T0 + 30_000, reason: 'interruption' as const }];
    const s = aggregate(recs, gaps);
    expect(s.validMs).toBe(15_000);
    expect(s.overloadS).toBe(5);
    expect(s.micBusyS).toBe(5);
    expect(s.gapMs).toBe(10_000);
    expect(s.lafmax).toBe(90);
    expect(s.laeq).toBeCloseTo(energyMeanWeighted([{ level: 40, seconds: 10 }, { level: 90, seconds: 5 }]), 9);
    expect(s.lastMs).toBe(T0 + 30_000);
    expect(lfHint(52, 41.9)).toEqual({ diffDb: expect.closeTo(10.1, 9), strong: true });
    expect(lfHint(50, 40).strong).toBe(false); // exactly 10 dB is not "more than 10"
  });

  it('zero valid seconds gives NaN levels, not a crash ("no data")', () => {
    const s = aggregate([]);
    expect(s.validMs).toBe(0);
    expect(Number.isNaN(s.laeq)).toBe(true);
    expect(s.firstMs).toBeNull();
  });

  it('background L90 excludes event seconds', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 100, db: 30 },
      { seconds: 100, db: 60 },
    ]);
    expect(backgroundL90(recs, [])).toBe(30);
    expect(backgroundL90(recs, [{ startMs: T0, endMs: T0 + 100_000 }])).toBe(60);
  });
});

describe('E5 dose (NIOSH / OSHA / EU)', () => {
  const h = 3600;
  it('2 h at 100 + 6 h at 85 dBA → NIOSH 875 %, TWA 94.42; OSHA 137.5 %, TWA 92.30; LEX,8h 94.37', () => {
    const recs = recordsFromScript(T0, [
      { seconds: 2 * h, db: 100 },
      { seconds: 6 * h, db: 85 },
    ]);
    const n = dose(recs, 'niosh');
    expect(n.dosePct.toFixed(1)).toBe('875.0');
    expect(n.twa.toFixed(2)).toBe('94.42');
    const o = dose(recs, 'osha');
    expect(o.dosePct.toFixed(1)).toBe('137.5');
    expect(o.twa.toFixed(2)).toBe('92.30');
    expect(dose(recs, 'eu').lex8h.toFixed(2)).toBe('94.37');
  });

  it('4 h at 88 → NIOSH 100 %, LEX,8h 84.99; adding 4 h below 80 keeps NIOSH at 100 %', () => {
    const recs = recordsFromScript(T0, [{ seconds: 4 * h, db: 88 }]);
    expect(dose(recs, 'niosh').dosePct.toFixed(2)).toBe('100.00');
    expect(dose(recs, 'eu').lex8h.toFixed(2)).toBe('84.99');
    const more = recordsFromScript(T0, [
      { seconds: 4 * h, db: 88 },
      { seconds: 4 * h, db: 79.9 },
    ]);
    expect(dose(more, 'niosh').dosePct.toFixed(2)).toBe('100.00');
  });

  it('2 h at 91 → NIOSH 100 %, projected 8-h dose 400 %', () => {
    const r = dose(recordsFromScript(T0, [{ seconds: 2 * h, db: 91 }]), 'niosh');
    expect(r.dosePct.toFixed(2)).toBe('100.00');
    expect(r.projectedPct.toFixed(1)).toBe('400.0');
  });

  it('OSHA uses LAS (slow) per second; NIOSH uses LAeq,1s; threshold 80 counts from exactly 80', () => {
    const recs = recordsFromScript(T0, [{ seconds: 10, db: 70 }]);
    recs.forEach((r) => (r.las = 95));
    expect(dose(recs, 'niosh').dosePct).toBe(0);
    expect(dose(recs, 'osha').dosePct).toBeCloseTo((100 * 10) / allowedSeconds('osha', 95), 12);
    expect(doseFromLevels('niosh', [80]).dosePct).toBeGreaterThan(0);
    expect(Number.isNaN(doseFromLevels('niosh', [79.9]).twa)).toBe(true);
    expect(allowedSeconds('niosh', 85)).toBe(8 * h);
    expect(lex8h(85, 8 * h)).toBe(85);
  });
});

describe('E8 calibration', () => {
  const steadyWindow = (mean: number, sigma: number) => {
    // 30 values with exactly the given population σ: half at mean+σ, half at mean−σ, then shifted so LAeq = mean.
    const raw = Array.from({ length: 30 }, (_, i) => mean + (i % 2 ? sigma : -sigma));
    const shift = mean - energyMean(raw);
    return raw.map((v) => v + shift);
  };

  it('app LAeq 58.1, reference 62.4 → offset +4.3 dB (σ 0.6 accepted)', () => {
    const r = calibrate(DEFAULT_OFFSET_DB, steadyWindow(58.1, 0.6), 62.4);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deltaDb.toFixed(1)).toBe('4.3');
      expect(r.newOffsetDb - DEFAULT_OFFSET_DB).toBeCloseTo(4.3, 9);
      expect(r.sigmaDb).toBeCloseTo(0.6, 9);
    }
  });

  it('σ 2.1 → rejected "unsteady"; |R − M| > 40 → "implausible"; < 20 s → "too-short"', () => {
    expect(calibrate(DEFAULT_OFFSET_DB, steadyWindow(58.1, 2.1), 62.4)).toMatchObject({ ok: false, reason: 'unsteady' });
    expect(calibrate(DEFAULT_OFFSET_DB, steadyWindow(58.1, 0.2), 99)).toMatchObject({ ok: false, reason: 'implausible' });
    expect(calibrate(DEFAULT_OFFSET_DB, steadyWindow(58.1, 0.2).slice(0, 19), 60)).toMatchObject({
      ok: false,
      reason: 'too-short',
    });
  });

  it('platform defaults: UNPROCESSED is the CDD factory nominal, every other source a placeholder', () => {
    expect(platformDefault('unprocessed')).toEqual({ offsetDb: DEFAULT_OFFSET_DB, method: 'platform-default', kind: 'factory-nominal' });
    expect(platformDefault('ios_measurement').kind).toBe('placeholder');
    expect(platformDefault('voice_recognition').kind).toBe('placeholder');
    expect(validManualOffset(130)).toBe(true);
    expect(validManualOffset(250)).toBe(false);
  });
});
