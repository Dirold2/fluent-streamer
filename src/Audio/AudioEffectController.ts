import type { AudioProcessor } from "../Audio/AudioProcessor.js";
import type { Logger } from "../Types/index.js";
import { getTimeString } from "../Core/utils.js";

export class AudioEffectController {
  private audioProcessor: AudioProcessor;
  private logger: Logger;
  private loggerTag: string;
  private verbose: boolean;

  private _volume: number;
  private _bass: number;
  private _treble: number;
  private _compressor: boolean;
  private _normalize: boolean;

  constructor(
    audioProcessor: AudioProcessor,
    config: { logger: Logger; loggerTag: string; verbose?: boolean },
    initialState: {
      volume: number;
      bass: number;
      treble: number;
      compressor: boolean;
      normalize: boolean;
    },
  ) {
    this.audioProcessor = audioProcessor;
    this.logger = config.logger;
    this.loggerTag = config.loggerTag;
    this.verbose = config.verbose ?? false;

    this._volume = initialState.volume;
    this._bass = initialState.bass;
    this._treble = initialState.treble;
    this._compressor = initialState.compressor;
    this._normalize = initialState.normalize ?? false;
  }

  setVolume(v: number): void {
    const oldValue = this._volume;
    this._volume = v;
    if (this.canUpdate()) {
      this.audioProcessor.volume = v;
    }
    this.logChange("Volume", oldValue, v);
  }

  setBass(b: number): void {
    const oldValue = this._bass;
    this._bass = b;
    if (this.canUpdate()) {
      this.audioProcessor.bass = b;
    }
    this.logChange("Bass", oldValue, b);
  }

  setTreble(t: number): void {
    const oldValue = this._treble;
    this._treble = t;
    if (this.canUpdate()) {
      this.audioProcessor.treble = t;
    }
    this.logChange("Treble", oldValue, t);
  }

  setCompressor(c: boolean): void {
    const oldValue = this._compressor;
    this._compressor = c;
    if (this.canUpdate()) {
      this.audioProcessor.compressor = c;
    }
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] Compressor changed: ${String(oldValue)} → ${String(c)}`,
      );
    }
  }

  setNormalize(n: boolean): void {
    const oldValue = this._normalize;
    this._normalize = n;
    if (this.canUpdate()) {
      this.audioProcessor.normalize = n; // Управление новым эффектом авто-нормализации
    }
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] Normalize changed: ${String(oldValue)} → ${String(n)}`,
      );
    }
  }

  startFade(targetVolume: number, durationMs: number): void {
    if (this.canUpdate()) {
      this.audioProcessor.startFade(targetVolume, durationMs);
    }
  }

  private canUpdate(): boolean {
    return (
      this.audioProcessor != null &&
      !this.audioProcessor.destroyed &&
      !this.audioProcessor.writableEnded
    );
  }

  private logChange(label: string, oldValue: number, newValue: number): void {
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] ${label} changed: ${oldValue} → ${newValue}`,
      );
    }
  }
}
