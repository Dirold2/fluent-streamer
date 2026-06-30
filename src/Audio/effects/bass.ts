import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import { BASS_MIN, BASS_MAX } from "../../Types/audio.js";
import {
  calcLowShelfCoeffs,
  calcPeakingCoeffs,
  processBiquad,
  userToGainDb,
} from "../AudioBiquad.js";

export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class BassEffect {
  public value = 0;
  public coeffs: { shelf: BiquadCoeffs; peak: BiquadCoeffs | null } | null =
    null;

  public shelfL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public shelfR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  public set(bass: number): void {
    this.value = normalizeBass(bass);
    this.coeffs = null;
  }

  public processStereo(
    l: number,
    r: number,
    channels: number,
    sampleRate: number,
  ): [number, number] {
    if (Math.abs(this.value) <= 0.001) return [l, r];

    if (!this.coeffs) {
      const gainDb = userToGainDb(this.value, 18);
      const shelf = calcLowShelfCoeffs(120, sampleRate, gainDb, 0.7);
      let peak: BiquadCoeffs | null = null;
      if (Math.abs(gainDb) > 6) {
        peak = calcPeakingCoeffs(60, sampleRate, gainDb * 0.5, 1.0);
      }
      this.coeffs = { shelf, peak };
    }

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
