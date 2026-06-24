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

  constructor(
    audioProcessor: AudioProcessor,
    config: { logger: Logger; loggerTag: string; verbose?: boolean },
    initialState: {
      volume: number;
      bass: number;
      treble: number;
      compressor: boolean;
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
  }

  setVolume(v: number): void {
    const oldValue = this._volume;
    this._volume = v;
    if (this.canUpdate()) {
      this.audioProcessor.setVolume(v);
    }
    this.logChange("Volume", oldValue, v);
  }

  setBass(b: number): void {
    const oldValue = this._bass;
    this._bass = b;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(b, this._treble, this._compressor);
    }
    this.logChange("Bass", oldValue, b);
  }

  setTreble(t: number): void {
    const oldValue = this._treble;
    this._treble = t;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(this._bass, t, this._compressor);
    }
    this.logChange("Treble", oldValue, t);
  }

  setCompressor(c: boolean): void {
    const oldValue = this._compressor;
    this._compressor = c;
    if (this.canUpdate()) {
      this.audioProcessor.setCompressor(c);
    }
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] Compressor changed: ${String(oldValue)} → ${String(c)}`,
      );
    }
  }

  setEqualizer(b: number, t: number, c: boolean): void {
    this._bass = b;
    this._treble = t;
    this._compressor = c;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(b, t, c);
    }
  }

  startFade(targetVolume: number, durationMs: number): void {
    this.audioProcessor?.startFade(targetVolume, durationMs);
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
