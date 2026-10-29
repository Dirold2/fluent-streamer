import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import { BASS_MIN, BASS_MAX } from "../../Types/audio.js";
import {
  calcLowShelfCoeffs,
  calcPeakingCoeffs,
  processBiquad,
  userToGainDb,
} from "../AudioBiquad.js";

import { EqualizerSmoothing, auxiliaryPeakGain } from "./EqualizerSmoothing.js";

export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class BassEffect {
  public value = 0;
  public coeffs: { shelf: BiquadCoeffs; peak: BiquadCoeffs | null } | null = null;

  public shelfL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public shelfR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  private readonly smoothing = new EqualizerSmoothing((gainDb, sampleRate) => {
    const scale = Math.min(1, (sampleRate * 0.45) / 120);
    return [
      calcLowShelfCoeffs(120 * scale, sampleRate, gainDb, 0.7),
      calcPeakingCoeffs(60 * scale, sampleRate, auxiliaryPeakGain(gainDb, 6, 0.5), 1.0),
    ];
  });

  public constructor(value = 0) {
    this.set(value);
  }

  public get active(): boolean {
    return this.smoothing.active;
  }

  public set(bass: number, durationMs = 0): void {
    this.value = normalizeBass(bass);
    this.smoothing.set(
      Math.abs(this.value) <= 0.001 ? 0 : userToGainDb(this.value, 18),
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
