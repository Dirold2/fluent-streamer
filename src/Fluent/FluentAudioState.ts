import type {
  AudioProcessingOptions,
  FFmpegRunResultExtended,
} from "../Types/index.js";

export class FluentAudioState {
  public enabled = false;
  public volume = 1;
  public bass = 0;
  public treble = 0;
  public compressor = false;

  private result: FFmpegRunResultExtended | null = null;
  private sampleRate?: number;
  private channels?: number;
  private cachedOptions: AudioProcessingOptions | null = null;
  private cachedHash = "";

  constructor(config?: {
    volume?: number;
    bass?: number;
    treble?: number;
    compressor?: boolean;
    enabled?: boolean;
    sampleRate?: number;
    channels?: number;
  }) {
    if (!config) return;
    this.volume = config.volume ?? 1;
    this.bass = config.bass ?? 0;
    this.treble = config.treble ?? 0;
    this.compressor = config.compressor ?? false;
    this.enabled = config.enabled ?? false;
    this.sampleRate = config.sampleRate;
    this.channels = config.channels;
  }

  /** Attach a live processor result — all setters will bridge through it. */
  attachResult(result: FFmpegRunResultExtended | null): void {
    this.result = result;
  }

  setVolume(v: number): this {
    this.volume = v;
    this.result?.setVolume?.(v);
    return this;
  }

  setBass(v: number): this {
    this.bass = v;
    this.result?.setBass?.(v);
    return this;
  }

  setTreble(v: number): this {
    this.treble = v;
    this.result?.setTreble?.(v);
    return this;
  }

  setCompressor(v: boolean): this {
    this.compressor = v;
    this.result?.setCompressor?.(v);
    return this;
  }

  enable(enable: boolean): this {
    this.enabled = enable;
    return this;
  }

  startFade(targetVolume: number, durationMs: number): this {
    this.volume = targetVolume;
    this.result?.startFade?.(targetVolume, durationMs);
    return this;
  }

  fadeIn(targetVolume = 1, durationMs = 1000): this {
    return this.startFade(targetVolume, durationMs);
  }

  fadeOut(durationMs = 1000): this {
    return this.startFade(0, durationMs);
  }

  changeVolume(v: number): boolean {
    if (this.result?.setVolume) {
      this.result.setVolume(v);
      this.volume = v;
      return true;
    }
    return false;
  }

  changeBass(v: number): boolean {
    if (this.result?.setBass) {
      this.result.setBass(v);
      this.bass = v;
      return true;
    }
    return false;
  }

  changeTreble(v: number): boolean {
    if (this.result?.setTreble) {
      this.result.setTreble(v);
      this.treble = v;
      return true;
    }
    return false;
  }

  changeCompressor(v: boolean): boolean {
    if (this.result?.setCompressor) {
      this.result.setCompressor(v);
      this.compressor = v;
      return true;
    }
    return false;
  }

  changeNormalize(v: boolean): boolean {
    if (this.result?.setNormalize) {
      this.result.setNormalize(v);
      this.compressor = v;
      return true;
    }
    return false;
  }

  buildOptions(sampleRate?: number, channels?: number): AudioProcessingOptions {
    this.sampleRate ??= sampleRate;
    this.channels ??= channels;
    const hash = `${this.volume}-${this.bass}-${this.treble}-${this.compressor}`;
    if (this.cachedOptions && this.cachedHash === hash)
      return this.cachedOptions;
    this.cachedOptions = {
      volume: this.volume,
      bass: this.bass,
      treble: this.treble,
      compressor: this.compressor,
      normalize: false,
      sampleRate: this.sampleRate,
      channels: this.channels,
    };
    this.cachedHash = hash;
    return this.cachedOptions;
  }

  debugInfo(): {
    volume: number;
    bass: number;
    treble: number;
    compressor: boolean;
    enabled: boolean;
  } {
    return {
      volume: this.volume,
      bass: this.bass,
      treble: this.treble,
      compressor: this.compressor,
      enabled: this.enabled,
    };
  }
}
