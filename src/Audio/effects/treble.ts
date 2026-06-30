import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import { TREBLE_MIN, TREBLE_MAX } from "../../Types/audio.js";
import {
  calcHighShelfCoeffs,
  calcPeakingCoeffs,
  processBiquad,
  userToGainDb,
} from "../AudioBiquad.js";

export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class TrebleEffect {
  public value = 0;
  public coeffs: { shelf: BiquadCoeffs; peak: BiquadCoeffs | null } | null =
    null;

  public shelfL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public shelfR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakL: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  public peakR: BiquadState = { x1: 0, x2: 0, y1: 0, y2: 0 };

  public set(treble: number): void {
    this.value = normalizeTreble(treble);
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
      const gainDb = userToGainDb(this.value, 12);
      const shelf = calcHighShelfCoeffs(8000, sampleRate, gainDb, 0.7);
      let peak: BiquadCoeffs | null = null;
      if (Math.abs(gainDb) > 3) {
        peak = calcPeakingCoeffs(12000, sampleRate, gainDb * 0.3, 1.2);
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
