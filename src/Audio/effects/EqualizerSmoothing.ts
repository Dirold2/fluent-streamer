import type { BiquadCoeffs } from "../../Types/audio.js";

const CONTROL_FRAMES = 32;
const keys = ["b0", "b1", "b2", "a1", "a2"] as const;

/** Gain ramps use audio frames, not calls to set(), channels or wall-clock time. */
export class EqualizerSmoothing {
  private gain = 0;
  private target = 0;
  private durationMs = 0;
  private remaining = 0;
  private sampleRate = 0;
  private segmentRemaining = 0;
  private destination: BiquadCoeffs[] = [];
  private increments: BiquadCoeffs[] = [];
  private coefficients: BiquadCoeffs[] | null = null;

  public constructor(
    private readonly design: (gainDb: number, sampleRate: number) => BiquadCoeffs[],
  ) {}

  public get active(): boolean {
    return this.target !== 0 || this.gain !== 0 || this.durationMs > 0 || this.remaining > 0;
  }

  public set(gainDb: number, durationMs: number): void {
    this.target = gainDb;
    this.segmentRemaining = 0;
    if (Number.isFinite(durationMs) && durationMs > 0 && this.gain !== gainDb) {
      this.durationMs = durationMs;
      this.remaining = 0;
    } else {
      this.gain = gainDb;
      this.durationMs = 0;
      this.remaining = 0;
      this.coefficients = null;
    }
  }

  public next(sampleRate: number): BiquadCoeffs[] {
    if (this.sampleRate !== sampleRate) {
      if (this.remaining > 0) {
        this.remaining = Math.max(1, Math.round((this.remaining * sampleRate) / this.sampleRate));
      }
      this.sampleRate = sampleRate;
      this.coefficients = null;
      this.segmentRemaining = 0;
    }
    if (this.durationMs > 0) {
      this.remaining = Math.max(1, Math.round((this.durationMs * sampleRate) / 1000));
      this.durationMs = 0;
    }
    if (!this.coefficients) this.coefficients = this.design(this.gain, sampleRate);
    if (this.remaining === 0) return this.coefficients;

    if (this.segmentRemaining === 0) {
      const frames = Math.min(CONTROL_FRAMES, this.remaining);
      const nextGain = this.gain + ((this.target - this.gain) * frames) / this.remaining;
      this.destination = this.design(nextGain, sampleRate);
      this.increments = this.coefficients.map((coeffs, i) => {
        const step = { ...coeffs };
        for (const key of keys) step[key] = (this.destination[i]![key] - coeffs[key]) / frames;
        return step;
      });
      this.segmentRemaining = frames;
    }

    // Normalized real biquad denominators have a convex Schur-stable region:
    // |a2| < 1, 1 + a1 + a2 > 0, 1 - a1 + a2 > 0. Both endpoints
    // are designed stable; interpolation never leaves that region. DF-I keeps
    // input/output histories meaningful as coefficients change (unlike DF-II).
    for (let i = 0; i < this.coefficients.length; i++) {
      for (const key of keys) this.coefficients[i]![key] += this.increments[i]![key];
    }
    this.gain += (this.target - this.gain) / this.remaining;
    this.remaining--;
    if (--this.segmentRemaining === 0) this.coefficients = this.destination;
    if (this.remaining === 0) this.gain = this.target;
    return this.coefficients;
  }
}

/** Fade the auxiliary bell in over 1 dB instead of switching a nonzero bell on. */
export function auxiliaryPeakGain(gainDb: number, threshold: number, amount: number): number {
  const t = Math.max(0, Math.min(1, Math.abs(gainDb) - threshold));
  return gainDb * amount * t * t * (3 - 2 * t);
}
