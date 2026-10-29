export class NormalizerEffect {
  public enabled: boolean;
  private prevScale = 1;
  private readonly TARGET_PEAK = 32767 * 10 ** (-1 / 20);
  private readonly MAX_GAIN = 4;
  private readonly NOISE_FLOOR = 32768 * 10 ** (-60 / 20);
  private readonly RELEASE_SECONDS = 0.5;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public set(enabled: boolean): void {
    if (this.enabled !== enabled) this.prevScale = 1;
    this.enabled = enabled;
  }

  public calculateScale(samples: Int16Array, sampleRate = 48000, channels = 2): number {
    if (!this.enabled || samples.length === 0) return 1;

    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]!));
    }

    // Do not amplify silence or accumulate gain while only the noise floor is present.
    if (peak <= this.NOISE_FLOOR) {
      this.prevScale = 1;
      return 1;
    }

    const targetScale = Math.min(this.MAX_GAIN, this.TARGET_PEAK / peak);
    if (targetScale < this.prevScale) {
      // Immediate attack: a loud block must never inherit gain from a quiet one.
      this.prevScale = targetScale;
    } else {
      // Use audio duration, not wall time or number of chunks, for gain recovery.
      const duration = samples.length / channels / sampleRate;
      const smoothing = Math.exp(-duration / this.RELEASE_SECONDS);
      this.prevScale = targetScale + (this.prevScale - targetScale) * smoothing;
    }
    return this.prevScale;
  }
}
