// Overload (clipping / flat-top) detection on raw samples (SPEC §7.5, A4).
// A sample counts as overload when |x| ≥ 0.999 (hard clip at full scale), or when it completes a run of ≥ 3 consecutive
// exactly equal samples with |x| ≥ 0.99 (a flat top at the input maximum). The run is carried across buffers, so the
// result does not depend on how the stream is cut into buffers.
// Decision (d) of fix round 1 (D29, replaces D25's ≥ 4 samples at ≥ 0.5): the old rule flagged an UNCLIPPED PCM16 sine
// below ~40 Hz above half scale (equal samples at every quantised crest; blind set 1, S40). At ≥ 0.99 a PCM16 20 Hz
// sine at −1 dBFS (peak 0.89) and at −0.1 dBFS (peak 0.9886) is not flagged. Cost: a limiter that flattens below
// 0.99 FS is no longer flagged; only a crest within 0.09 dB of full scale still can be.

export const CLIP_LEVEL = 0.999;
export const FLAT_TOP_MIN = 0.99;
export const FLAT_TOP_RUN = 3;

export type OverloadDetector = { step(x: number): boolean; reset(): void };

export function createOverloadDetector(): OverloadDetector {
  let last = NaN;
  let run = 0;
  return {
    step(x: number): boolean {
      const ax = Math.abs(x);
      if (x === last) run++;
      else {
        last = x;
        run = 1;
      }
      return ax >= CLIP_LEVEL || (ax >= FLAT_TOP_MIN && run >= FLAT_TOP_RUN);
    },
    reset() {
      last = NaN;
      run = 0;
    },
  };
}
