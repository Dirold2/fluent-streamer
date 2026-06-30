import type { BiquadCoeffs, BiquadState } from "../Types/audio.js";

export function userToGainLinear(userVal: number, maxDb = 12): number {
  const v = Math.max(-1, Math.min(1, userVal));
  const db = Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
  return Math.pow(10, db / 20);
}

export function userToGainDb(userVal: number, maxDb = 15): number {
  const v = Math.max(-1, Math.min(1, userVal));
  return Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
}

export function calcLowShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 - (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
  const b2 = A * (A + 1 - (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 + (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = -2 * (A - 1 + (A + 1) * cosW0);
  const a2 = A + 1 + (A - 1) * cosW0 - sqrtA2Alpha;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function calcPeakingCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function calcHighShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
  const b2 = A * (A + 1 + (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 - (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosW0);
  const a2 = A + 1 - (A - 1) * cosW0 - sqrtA2Alpha;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function processBiquad(
  input: number,
  coeffs: BiquadCoeffs,
  state: BiquadState,
): number {
  const output =
    coeffs.b0 * input +
    coeffs.b1 * state.x1 +
    coeffs.b2 * state.x2 -
    coeffs.a1 * state.y1 -
    coeffs.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
}
