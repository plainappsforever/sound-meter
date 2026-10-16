// Second-order sections (biquads): design helpers and Direct Form II transposed processing in Float64.
// Pure TypeScript, no React/Expo imports (SPEC §7).

/** One section: H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2). */
export type Sos = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** A cascade of sections with an overall gain. */
export type Cascade = { gain: number; sections: Sos[] };

/** First-order analog factor s/(s+w) (high-pass) or w/(s+w) (low-pass), bilinear transform at fs, as [b0, b1], [1, a1]. */
type FirstOrder = { b: [number, number]; a1: number };

function bilinearHighpass1(wRad: number, fs: number): FirstOrder {
  const k = 2 * fs;
  const d = k + wRad;
  return { b: [k / d, -k / d], a1: (wRad - k) / d };
}

/** Product of two first-order bilinear sections → one biquad. */
function multiply(p: FirstOrder, q: FirstOrder): Sos {
  return {
    b0: p.b[0] * q.b[0],
    b1: p.b[0] * q.b[1] + p.b[1] * q.b[0],
    b2: p.b[1] * q.b[1],
    a1: p.a1 + q.a1,
    a2: p.a1 * q.a1,
  };
}

/** Two analog high-pass poles (s/(s+w1))·(s/(s+w2)) at w1, w2 (Hz), bilinear transform at fs. */
export function bilinearHighpassPair(f1Hz: number, f2Hz: number, fs: number): Sos {
  return multiply(bilinearHighpass1(2 * Math.PI * f1Hz, fs), bilinearHighpass1(2 * Math.PI * f2Hz, fs));
}

/** Second-order Butterworth high-pass (Q = 1/√2) at fc by the bilinear transform with pre-warping (Z DC blocker). */
export function butterworthHighpass(fcHz: number, fs: number): Sos {
  const k = Math.tan((Math.PI * fcHz) / fs);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + k / q + k * k);
  return { b0: norm, b1: -2 * norm, b2: norm, a1: 2 * (k * k - 1) * norm, a2: (1 - k / q + k * k) * norm };
}

/** Two analog low-pass poles w²/(s+w)² by the plain bilinear transform (kept for the error table in tests, D25). */
export function bilinearLowpassDouble(fHz: number, fs: number): Sos {
  const w = 2 * Math.PI * fHz;
  const k = 2 * fs;
  const d = k + w;
  const lp: FirstOrder = { b: [w / d, w / d], a1: (w - k) / d };
  return multiply(lp, lp);
}

/**
 * Magnitude-matched second-order low-pass (M. Vicanek, "Matched Second Order Digital Filters", 2016,
 * https://vicanek.de/articles/BiquadFits.pdf, section "Lowpass"). Poles by impulse invariance, numerator chosen so the
 * digital magnitude equals the analog one at DC, at the pole frequency and closely up to Nyquist — no frequency
 * warping. Used for the A/C weighting pole pair at f4 = 12194 Hz, where the bilinear transform loses up to 6 dB at
 * 16 kHz (D22, D25). `q` = 0.5 for the double real pole.
 */
export function matchedLowpass(f0Hz: number, q: number, fs: number): Sos {
  const w0 = (2 * Math.PI * f0Hz) / fs;
  const zeta = 1 / (2 * q);
  const a1 =
    zeta <= 1
      ? -2 * Math.exp(-zeta * w0) * Math.cos(Math.sqrt(1 - zeta * zeta) * w0)
      : -2 * Math.exp(-zeta * w0) * Math.cosh(Math.sqrt(zeta * zeta - 1) * w0);
  const a2 = Math.exp(-2 * zeta * w0);
  const A0 = (1 + a1 + a2) ** 2;
  const A1 = (1 - a1 + a2) ** 2;
  const A2 = -4 * a2;
  const s2 = Math.sin(w0 / 2) ** 2;
  const phi0 = 1 - s2;
  const phi1 = s2;
  const phi2 = 4 * phi0 * phi1;
  const R1 = (A0 * phi0 + A1 * phi1 + A2 * phi2) * q * q;
  const B0 = A0;
  const B1 = (R1 - B0 * phi0) / phi1;
  const b0 = 0.5 * (Math.sqrt(B0) + Math.sqrt(Math.max(B1, 0)));
  const b1 = Math.sqrt(B0) - b0;
  return { b0, b1, b2: 0, a1, a2 };
}

/** |H(e^{j2πf/fs})| of a cascade (including its gain). */
export function magnitude(c: Cascade, fHz: number, fs: number): number {
  const w = (2 * Math.PI * fHz) / fs;
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  let m = Math.abs(c.gain);
  for (const s of c.sections) {
    const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
    const ni = s.b1 * s1 + s.b2 * s2;
    const dr = 1 + s.a1 * c1 + s.a2 * c2;
    const di = s.a1 * s1 + s.a2 * s2;
    m *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return m;
}

/** Streaming filter state for a cascade; state is carried across buffers (buffer-boundary invariant). */
export type CascadeFilter = {
  /** Filters one sample and returns the output. */
  step(x: number): number;
  reset(): void;
};

export function createCascadeFilter(c: Cascade): CascadeFilter {
  const n = c.sections.length;
  const b0 = new Float64Array(n);
  const b1 = new Float64Array(n);
  const b2 = new Float64Array(n);
  const a1 = new Float64Array(n);
  const a2 = new Float64Array(n);
  c.sections.forEach((s, i) => {
    b0[i] = s.b0;
    b1[i] = s.b1;
    b2[i] = s.b2;
    a1[i] = s.a1;
    a2[i] = s.a2;
  });
  const z1 = new Float64Array(n);
  const z2 = new Float64Array(n);
  const gain = c.gain;
  return {
    step(x: number): number {
      let v = x * gain;
      for (let i = 0; i < n; i++) {
        const y = b0[i] * v + z1[i];
        z1[i] = b1[i] * v - a1[i] * y + z2[i];
        z2[i] = b2[i] * v - a2[i] * y;
        v = y;
      }
      return v;
    },
    reset() {
      z1.fill(0);
      z2.fill(0);
    },
  };
}
