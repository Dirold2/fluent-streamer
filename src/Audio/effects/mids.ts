import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import { MIDS_MIN, MIDS_MAX } from "../../Types/audio.js";
import { calcPeakingCoeffs, processBiquad, userToGainDb } from "../AudioBiquad.js";

import { EqualizerSmoothing } from "./EqualizerSmoothing.js";

export function normalizeMids(mids: number): number {
  const range = MIDS_MAX - MIDS_MIN;
  if (range === 0) return 0;
  const normalized = ((mids - MIDS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class MidsEffect {
  public value = 0;
  public coeffs: BiquadCoeffs | null = null;
  public peakL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  private readonly smoothing = new EqualizerSmoothing((gainDb, sampleRate) => [
    // A broad midrange bell, kept below Nyquist even at low sample rates.
    calcPeakingCoeffs(Math.min(1000, sampleRate * 0.45), sampleRate, gainDb, 0.7),
  ]);

  public constructor(value = 0) {
    this.set(value);
  }

  public get active(): boolean {
    return this.smoothing.active;
  }

  public set(mids: number, durationMs = 0): void {
    this.value = normalizeMids(mids);
    this.smoothing.set(
      Math.abs(this.value) <= 0.001 ? 0 : userToGainDb(this.value, 12),
      durationMs,
    );
    if (durationMs <= 0) this.coeffs = null;
  }

  public processStereo(
    l: number,
    r: number,
    channels: number,
    sampleRate: number,
  ): [number, number] {
    if (!this.active) {
      this.peakL.x2 = this.peakL.x1;
      this.peakL.y2 = this.peakL.y1;
      this.peakL.x1 = this.peakL.y1 = l;
      if (channels > 1) {
        this.peakR.x2 = this.peakR.x1;
        this.peakR.y2 = this.peakR.y1;
        this.peakR.x1 = this.peakR.y1 = r;
      }
      return [l, r];
    }

    this.coeffs = this.smoothing.next(sampleRate)[0]!;

    l = processBiquad(l, this.coeffs, this.peakL);
    if (channels > 1) r = processBiquad(r, this.coeffs, this.peakR);
    return [l, r];
  }
}
