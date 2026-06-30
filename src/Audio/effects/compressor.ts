export function compressSample(
  value: number,
  threshold = 0.8,
  ratio = 4,
): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return value;
  const excess = abs - threshold;
  const compressed = threshold + excess / ratio;
  return Math.sign(value) * compressed;
}

export class CompressorEffect {
  public enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  public set(enabled: boolean): void {
    this.enabled = enabled;
  }
}
