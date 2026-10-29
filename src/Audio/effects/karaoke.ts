import { calcHighShelfCoeffs, processBiquad } from "../AudioBiquad.js";
import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";

const emptyState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** Stereo-preserving, frequency-selective center suppression; not vocal isolation. */
export class KaraokeEffect {
  private target: boolean;
  private wet: number;
  private readonly step: number;
  private readonly envelope: number;
  private readonly lower: BiquadCoeffs;
  private readonly upper: BiquadCoeffs;
  private lowerState = emptyState();
  private upperState = emptyState();
  private midEnergy = 0;
  private sideEnergy = 0;

  constructor(enabled = false, sampleRate = 48000) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0)
      throw new RangeError("KaraokeEffect sampleRate must be finite and positive");
    this.target = enabled;
    this.wet = enabled ? 1 : 0;
    this.step = 1 / Math.max(1, Math.round(sampleRate * 0.05));
    this.envelope = 1 - Math.exp(-1 / (sampleRate * 0.02));
    // Reciprocal shelves retain DC and the top end while cutting the vocal midrange.
    // Scale both knees together at low sample rates, always below Nyquist.
    const upperFrequency = Math.min(6000, sampleRate * 0.4);
    const lowerFrequency = upperFrequency * (180 / 6000);
    this.lower = calcHighShelfCoeffs(lowerFrequency, sampleRate, -24);
    this.upper = calcHighShelfCoeffs(upperFrequency, sampleRate, 24);
  }

  get enabled(): boolean {
    return this.target;
  }
  get active(): boolean {
    return this.target || this.wet > 0;
  }

  public set(enabled: boolean): void {
    if (enabled && !this.active) {
      this.lowerState = emptyState();
      this.upperState = emptyState();
      this.midEnergy = this.sideEnergy = 0;
    }
    this.target = enabled;
  }

  public processStereo(left: number, right: number, channels: number): [number, number] {
    if (channels !== 2 || !this.active) return [left, right];
    this.wet = this.target ? Math.min(1, this.wet + this.step) : Math.max(0, this.wet - this.step);
    // Snap the floating-point tail so disabled effects eventually allow byte-exact bypass.
    if (!this.target && this.wet < this.step * 1e-6) this.wet = 0;
    const mid = (left + right) / 2;
    const side = (left - right) / 2;
    this.midEnergy += this.envelope * (mid * mid - this.midEnergy);
    this.sideEnergy += this.envelope * (side * side - this.sideEnergy);
    const energy = this.midEnergy + this.sideEnergy;
    // Hard-panned sources have equal mid/side energy: avoid treating them as centered vocals.
    const coherence = energy > 1e-20 ? Math.max(0, (this.midEnergy - this.sideEnergy) / energy) : 0;
    const filtered = processBiquad(
      processBiquad(mid, this.lower, this.lowerState),
      this.upper,
      this.upperState,
    );
    const removed = (mid - filtered) * this.wet * coherence;
    return [left - removed, right - removed];
  }
}
