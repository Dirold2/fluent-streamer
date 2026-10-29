import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import { TREBLE_MIN, TREBLE_MAX } from "../../Types/audio.js";
import {
  calcHighShelfCoeffs,
  calcPeakingCoeffs,
  processBiquad,
  userToGainDb,
} from "../AudioBiquad.js";

import { EqualizerSmoothing, auxiliaryPeakGain } from "./EqualizerSmoothing.js";

export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class TrebleEffect {
  public value = 0;
  public coeffs: { shelf: BiquadCoeffs; peak: BiquadCoeffs | null } | null = null;

  public shelfL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public shelfR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  private readonly smoothing = new EqualizerSmoothing((gainDb, sampleRate) => {
    // Keep the bands ordered and safely below Nyquist at low sample rates.
    const frequencyScale = Math.min(1, (sampleRate * 0.45) / 12000);
    return [
      calcHighShelfCoeffs(8000 * frequencyScale, sampleRate, gainDb, 0.7),
      calcPeakingCoeffs(12000 * frequencyScale, sampleRate, auxiliaryPeakGain(gainDb, 3, 0.3), 1.2),
    ];
  });

  public constructor(value = 0) {
    this.set(value);
  }

  public get active(): boolean {
    return this.smoothing.active;
  }

  public set(treble: number, durationMs = 0): void {
    this.value = normalizeTreble(treble);
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
      for (const state of [this.shelfL, this.peakL]) {
        state.x2 = state.x1;
        state.y2 = state.y1;
        state.x1 = state.y1 = l;
      }
      if (channels > 1)
        for (const state of [this.shelfR, this.peakR]) {
          state.x2 = state.x1;
          state.y2 = state.y1;
          state.x1 = state.y1 = r;
        }
      return [l, r];
    }

    const [shelf, peak] = this.smoothing.next(sampleRate);
    this.coeffs = { shelf: shelf!, peak: peak! };

    l = processBiquad(l, this.coeffs.shelf, this.shelfL);
    if (channels > 1) {
      r = processBiquad(r, this.coeffs.shelf, this.shelfR);
    }

    if (this.coeffs.peak) {
      l = processBiquad(l, this.coeffs.peak, this.peakL);
      if (channels > 1) {
        r = processBiquad(r, this.coeffs.peak, this.peakR);
      }
    }

    return [l, r];
  }
}
