import type { AudioProcessingOptions, FFmpegRunResultExtended } from "../Types/index.js";

export class FluentAudioState {
  public enabled = false;
  public volume = 1;
  public bass = 0;
  public treble = 0;
  public mids = 0;
  public compressor = false;
  public karaoke = false;

  private result: FFmpegRunResultExtended | null = null;
  private readonly eqMirrors = new Set<FFmpegRunResultExtended>();
  private sampleRate?: number;
  private channels?: number;
  private cachedOptions: AudioProcessingOptions | null = null;
  private cachedHash = "";

  constructor(config?: {
    volume?: number;
    bass?: number;
    treble?: number;
    mids?: number;
    compressor?: boolean;
    karaoke?: boolean;
    enabled?: boolean;
    sampleRate?: number;
    channels?: number;
  }) {
    if (!config) return;
    this.volume = config.volume ?? 1;
    this.bass = config.bass ?? 0;
    this.treble = config.treble ?? 0;
    this.mids = config.mids ?? 0;
    this.compressor = config.compressor ?? false;
    this.karaoke = config.karaoke ?? false;
    this.enabled = config.enabled ?? false;
    this.sampleRate = config.sampleRate;
    this.channels = config.channels;
  }

  /** Attach a live processor result — all setters will bridge through it. */
  attachResult(result: FFmpegRunResultExtended | null): void {
    this.result = result;
    if (!result) this.eqMirrors.clear();
  }

  /** Keep a prepared decoder's EQ current without moving the active controls. */
  mirrorEq(result: FFmpegRunResultExtended): () => void {
    result.setBass?.(this.bass);
    result.setMids?.(this.mids);
    result.setTreble?.(this.treble);
    this.eqMirrors.add(result);
    return () => this.eqMirrors.delete(result);
  }

  private forwardEq(key: "setBass" | "setMids" | "setTreble", value: number): void {
    this.result?.[key]?.(value);
    for (const mirror of this.eqMirrors) {
      if (mirror !== this.result) mirror[key]?.(value);
    }
  }

  setVolume(v: number): this {
    this.volume = v;
    this.result?.setVolume?.(v);
    return this;
  }

  setBass(v: number): this {
    this.bass = v;
    this.forwardEq("setBass", v);
    return this;
  }

  setTreble(v: number): this {
    this.treble = v;
    this.forwardEq("setTreble", v);
    return this;
  }

  setMids(v: number): this {
    this.mids = v;
    this.forwardEq("setMids", v);
    return this;
  }

  setCompressor(v: boolean): this {
    this.compressor = v;
    this.result?.setCompressor?.(v);
    return this;
  }

  setKaraoke(enabled: boolean): this {
    this.karaoke = enabled;
    this.result?.setKaraoke?.(enabled);
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
      this.setBass(v);
      return true;
    }
    return false;
  }

  changeTreble(v: number): boolean {
    if (this.result?.setTreble) {
      this.setTreble(v);
      return true;
    }
    return false;
  }

  changeMids(v: number): boolean {
    if (this.result?.setMids) {
      this.setMids(v);
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

  changeKaraoke(enabled: boolean): boolean {
    if (this.result?.setKaraoke) {
      this.result.setKaraoke(enabled);
      this.karaoke = enabled;
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
    const hash = `${this.volume}-${this.bass}-${this.treble}-${this.mids}-${this.compressor}-${this.karaoke}`;
    if (this.cachedOptions && this.cachedHash === hash) return this.cachedOptions;
    this.cachedOptions = {
      volume: this.volume,
      bass: this.bass,
      treble: this.treble,
      mids: this.mids,
      compressor: this.compressor,
      karaoke: this.karaoke,
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
    mids: number;
    compressor: boolean;
    karaoke: boolean;
    enabled: boolean;
  } {
    return {
      volume: this.volume,
      bass: this.bass,
      treble: this.treble,
      mids: this.mids,
      compressor: this.compressor,
      karaoke: this.karaoke,
      enabled: this.enabled,
    };
  }
}
