export class NormalizerEffect {
  public enabled: boolean;
  private prevScale = 1;
  private readonly SMOOTHING = 0.85;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public set(enabled: boolean): void {
    this.enabled = enabled;
  }

  public calculateScale(samples: Int16Array): number {
    if (!this.enabled) return 1;

    let peak = 0;
    const totalSamples = samples.length;
    for (let i = 0; i < totalSamples; i++) {
      const v = samples[i]!;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }

    const rawScale = peak > 0 ? 32767 / peak : 1;
    this.prevScale =
      this.prevScale * this.SMOOTHING + rawScale * (1 - this.SMOOTHING);
    return this.prevScale;
  }
}
