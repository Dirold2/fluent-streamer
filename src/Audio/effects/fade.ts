import { clampVolume } from "./volume.js";

export class FadeEffect {
  public active = false;
  public from = 1;
  public to = 1;
  public samplesTotal = 0;
  public samplesDone = 0;

  public start(
    targetVolume: number,
    durationMs: number,
    currentVolume: number,
    sampleRate: number,
  ): { from: number; to: number } {
    const target = clampVolume(targetVolume);
    const total = Math.max(1, Math.round((durationMs / 1000) * sampleRate));

    this.from = currentVolume;
    this.to = target;
    this.samplesTotal = total;
    this.samplesDone = 0;
    this.active = true;

    return { from: this.from, to: this.to };
  }

  public next(currentVolume: number): {
    volume: number;
    justFinished: boolean;
  } {
    if (!this.active) {
      return { volume: currentVolume, justFinished: false };
    }

    const progress =
      this.samplesTotal > 0
        ? Math.min(1, this.samplesDone / this.samplesTotal)
        : 1;
    const current = this.from + (this.to - this.from) * progress;
    this.samplesDone++;

    if (this.samplesDone >= this.samplesTotal) {
      this.active = false;
      this.samplesDone = 0;
      this.samplesTotal = 0;
      return { volume: this.to, justFinished: true };
    }

    return { volume: current, justFinished: false };
  }
}
