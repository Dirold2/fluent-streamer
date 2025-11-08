import { Transform } from "stream";
import { AudioProcessingOptions } from "../Types/index.js";

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const BASS_MIN = -20;
export const BASS_MAX = 20;
export const TREBLE_MIN = -20;
export const TREBLE_MAX = 20;

export interface FilterState {
  trebleL: number;
  trebleR: number;
  bass60L: number;
  bass60R: number;
  bass120L: number;
  bass120R: number;
  bassLowpassL: number;
  bassLowpassR: number;
}

export function userToGainLinear(userVal: number, maxDb = 12): number {
  const v = Math.max(-1, Math.min(1, userVal));
  const db = Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
  return Math.pow(10, db / 20);
}

export function userToGainDb(userVal: number, maxDb = 15): number {
  const v = Math.max(-1, Math.min(1, userVal));
  return Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
}

export function compressSample(value: number, threshold = 0.8, ratio = 4): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return value;
  const excess = abs - threshold;
  const compressed = threshold + excess / ratio;
  return Math.sign(value) * compressed;
}

export function clampVolume(volume: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, volume));
}

export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export class AudioProcessor extends Transform {
  public volume: number;
  public bass: number;
  public treble: number;
  public compressor: boolean;

  private isDestroyed = false;

  // Sample-accurate fade
  private fadeActive = false;
  private fadeFrom = 1;
  private fadeTo = 1;
  private fadeSamplesTotal = 0;
  private fadeSamplesDone = 0;

  // Format
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly frameSizeBytes: number = 0;

  // State
  public filterState: FilterState = {
    trebleL: 0,
    trebleR: 0,
    bass60L: 0,
    bass60R: 0,
    bass120L: 0,
    bass120R: 0,
    bassLowpassL: 0,
    bassLowpassR: 0,
  };

  // Buffer for incomplete frames
  private leftover: Buffer | null = null;

  constructor(options: AudioProcessingOptions & { sampleRate?: number; channels?: number } = {
    volume: 1, bass: 0, treble: 0, compressor: false, normalize: false, sampleRate: 48000, channels: 2,
  }) {
    super({
      readableObjectMode: false,
      writableObjectMode: false,
      allowHalfOpen: false,
      decodeStrings: true,
      highWaterMark: 4096,
    });

    this.sampleRate = options.sampleRate ?? 48000;
    this.channels = options.channels ?? 2;
    this.frameSizeBytes = this.channels * 2; // 2 bytes per sample, interleaved

    this.volume = clampVolume(options.volume ?? 1);
    this.bass = normalizeBass(options.bass ?? 0);
    this.treble = normalizeTreble(options.treble ?? 0);
    this.compressor = !!options.compressor;

    this.setupEventHandlers();
  }

  private shouldBypass(): boolean {
    return !this.fadeActive
      && this.volume === 1
      && Math.abs(this.bass) < 1e-6
      && Math.abs(this.treble) < 1e-6
      && !this.compressor;
  }

  public setVolume(volume: number): void {
    if (this.isTerminated()) return;
    this.volume = clampVolume(volume);
  }

  public startFade(targetVolume: number, durationMs: number): void {
    if (this.isTerminated()) return;

    const to = clampVolume(targetVolume);
    const samples = Math.max(1, Math.round((durationMs / 1000) * this.sampleRate));

    this.fadeFrom = this.volume;
    this.fadeTo = to;
    this.fadeSamplesTotal = samples;
    this.fadeSamplesDone = 0;
    this.fadeActive = true;

    this.emit("fade-start", { from: this.fadeFrom, to: this.fadeTo, durationMs });
  }

  public setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isTerminated()) return;
    this.bass = normalizeBass(bass);
    this.treble = normalizeTreble(treble);
    this.compressor = compressor;
  }

  public setCompressor(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.compressor = enabled;
  }

  // Internal fade progression per sample
  private nextVolume(): number {
    if (!this.fadeActive) return this.volume;
    const progress = Math.min(1, this.fadeSamplesDone / this.fadeSamplesTotal);
    const current = this.fadeFrom + (this.fadeTo - this.fadeFrom) * progress;
    this.fadeSamplesDone++;
    if (this.fadeSamplesDone >= this.fadeSamplesTotal) {
      this.volume = this.fadeTo;
      this.fadeActive = false;
      this.fadeSamplesDone = 0;
      this.fadeSamplesTotal = 0;
      this.emit("fade-end", { to: this.fadeTo });
    }
    return current;
  }

  private processStereoSample(left: number, right: number, v: number): [number, number] {
    // Convert to float and apply volume in one step (optimization)
    let l = (left * v) / 32768;
    let r = (right * v) / 32768;

    // Bass EQ
    if (Math.abs(this.bass) > 0.001) {
      [l, r] = this.applyBassFilter(l, r);
    }

    // Treble
    if (Math.abs(this.treble) > 0.001) {
      [l, r] = this.applyTrebleFilter(l, r);
    }

    // Compressor
    if (this.compressor) {
      l = compressSample(l);
      r = compressSample(r);
    }

    // Fast clamp using conditional (optimization)
    l = l < -1 ? -1 : l > 1 ? 1 : l;
    r = r < -1 ? -1 : r > 1 ? 1 : r;

    // Convert back with rounding
    return [l * 32767 + (l < 0 ? -0.5 : 0.5) | 0, r * 32767 + (r < 0 ? -0.5 : 0.5) | 0];
  }

  private applyBassFilter(l: number, r: number): [number, number] {
    const bassGainDb = userToGainDb(this.bass, 18);

    const lowpassFreq =
      bassGainDb >= 0
        ? 4000 - (bassGainDb * 110) / 18  // Optimized division
        : 4000 + (Math.abs(bassGainDb) * 1000) / 18;

    const lowpassQ =
      bassGainDb >= 0
        ? 0.7 + (bassGainDb * 1.8) / 18
        : 0.7 - (Math.abs(bassGainDb) * 0.4) / 18;

    const bassGain60 = userToGainLinear(this.bass * 0.7, 18);
    const alpha60 = (2 * Math.PI * 60) / this.sampleRate;

    // Optimized: single multiplication instead of separate operations
    const alpha60Inv = 1 - alpha60;
    this.filterState.bass60L = this.filterState.bass60L * alpha60Inv + l * alpha60;
    this.filterState.bass60R = this.filterState.bass60R * alpha60Inv + r * alpha60;

    const gain60Adj = bassGain60 - 1;
    l += this.filterState.bass60L * gain60Adj;
    r += this.filterState.bass60R * gain60Adj;

    const eqGain120 = userToGainLinear(this.bass * 0.5, 18);
    const alpha120 = (2 * Math.PI * 120) / this.sampleRate;

    const alpha120Inv = 1 - alpha120;
    this.filterState.bass120L = this.filterState.bass120L * alpha120Inv + l * alpha120;
    this.filterState.bass120R = this.filterState.bass120R * alpha120Inv + r * alpha120;

    const gain120Adj = eqGain120 - 1;
    l += this.filterState.bass120L * gain120Adj;
    r += this.filterState.bass120R * gain120Adj;

    const effectiveAlpha = (2 * Math.PI * lowpassFreq) / this.sampleRate;
    const qInfluence = Math.min(lowpassQ * 0.5, 0.95);

    const alphaAdj = 1 - effectiveAlpha * qInfluence;
    const alphaAdjInv = effectiveAlpha * qInfluence;
    this.filterState.bassLowpassL = this.filterState.bassLowpassL * alphaAdj + l * alphaAdjInv;
    this.filterState.bassLowpassR = this.filterState.bassLowpassR * alphaAdj + r * alphaAdjInv;

    const blendFactor = 0.3 + (lowpassQ - 0.7) * 0.2;

    l = this.filterState.bassLowpassL + (l - this.filterState.bassLowpassL) * blendFactor;
    r = this.filterState.bassLowpassR + (r - this.filterState.bassLowpassR) * blendFactor;

    if (Math.abs(bassGainDb) > 6) {
      l = this.applyLimiter(l);
      r = this.applyLimiter(r);
    }

    return [l, r];
  }

  private applyTrebleFilter(l: number, r: number): [number, number] {
    const trebleGain = userToGainLinear(this.treble, 12);
    const alphaTreble = (2 * Math.PI * 4000) / this.sampleRate;

    const lpStateL = this.filterState.trebleL + alphaTreble * (l - this.filterState.trebleL);
    const lpStateR = this.filterState.trebleR + alphaTreble * (r - this.filterState.trebleR);

    const highPassL = l - lpStateL;
    const highPassR = r - lpStateR;

    this.filterState.trebleL = lpStateL;
    this.filterState.trebleR = lpStateR;

    l += highPassL * (trebleGain - 1);
    r += highPassR * (trebleGain - 1);

    return [l, r];
  }

  private applyLimiter(value: number, threshold = 0.85, ratio = 8): number {
    const abs = Math.abs(value);
    if (abs <= threshold) return value;
    const excess = abs - threshold;
    const compressed = threshold + excess / ratio;
    return Math.sign(value) * compressed;
  }

  private isTerminated(): boolean {
    return this.isDestroyed || this.destroyed || this.writableEnded;
  }

  private setupEventHandlers(): void {
    this.on("error", () => {
      // Do not spam logs; consumer can handle
    });
    this.on("close", () => {
      this.isDestroyed = true;
    });
  }

  _transform(chunk: Buffer, _encoding: string, callback: (err?: Error, data?: Buffer) => void) {
    try {
      if (this.isTerminated()) return callback();

      const input = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
      const remainder = input.length % this.frameSizeBytes;
      const alignedBytes = input.length - remainder;

      if (alignedBytes === 0) {
        // Keep everything for the next chunk
        this.leftover = input;
        return callback();
      }

      const toProcess = input.subarray(0, alignedBytes);
      this.leftover = remainder ? input.subarray(alignedBytes) : null;

      if (this.shouldBypass()) {
        // Fast path: no processing, just pass aligned bytes
        return callback(undefined, toProcess);
      }

      // Process in place on a copy (safe for concat-ed input)
      const out = Buffer.from(toProcess); // copy
      const samples = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
      const frameCount = out.byteLength / this.frameSizeBytes;

      // Pre-calculate volume if no fade is active (optimization)
      const hasFade = this.fadeActive;
      let currentVolume = this.volume;

      for (let frame = 0; frame < frameCount; frame++) {
        const idx = frame * this.channels;
        const left = samples[idx];
        const right = samples[idx + 1] ?? left;

        // Get volume (optimized path for no fade)
        if (hasFade) {
          currentVolume = this.nextVolume();
        }

        const [pl, pr] = this.processStereoSample(left, right, currentVolume);
        samples[idx] = pl;
        if (this.channels > 1) samples[idx + 1] = pr;
      }

      return callback(undefined, out);
    } catch (err) {
      this.destroy(err as Error);
      return callback();
    }
  }

  _flush(callback: (error?: Error | null, data?: Buffer) => void) {
    try {
      if (this.leftover && this.leftover.length > 0) {
        // Zero-pad leftover to complete one frame
        const pad = this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes);
        const padded = pad < this.frameSizeBytes ? Buffer.concat([this.leftover, Buffer.alloc(pad, 0)]) : this.leftover;

        // Run through transform logic one more time
        this.leftover = null;
        // Reuse _transform processing path
        this._transform(padded, "buffer", (err, data) => {
          if (err) return callback(err);
          if (data) this.push(data);
          callback();
        });
      } else {
        callback();
      }
    } catch (e) {
      callback(e as Error);
    }
  }

  override destroy(error?: Error): this {
    if (this.isDestroyed) return this;
    this.isDestroyed = true;
    this.leftover = null;
    super.destroy(error);
    return this;
  }

  /**
   * Process a complete PCM buffer (non-streaming)
   * @param buffer - Complete PCM s16le buffer
   * @returns Processed buffer
   */
  public processBuffer(buffer: Buffer): Buffer {
    if (this.shouldBypass()) {
      return buffer;
    }

    const input = this.leftover ? Buffer.concat([this.leftover, buffer]) : buffer;
    const remainder = input.length % this.frameSizeBytes;
    const alignedBytes = input.length - remainder;

    if (alignedBytes === 0) {
      this.leftover = input;
      return Buffer.alloc(0);
    }

    const toProcess = input.subarray(0, alignedBytes);
    this.leftover = remainder ? input.subarray(alignedBytes) : null;

    // Process in place on a copy
    const out = Buffer.from(toProcess);
    const samples = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    const frameCount = out.byteLength / this.frameSizeBytes;

    // Pre-calculate volume if no fade is active
    const hasFade = this.fadeActive;
    let currentVolume = this.volume;

    for (let frame = 0; frame < frameCount; frame++) {
      const idx = frame * this.channels;
      const left = samples[idx];
      const right = samples[idx + 1] ?? left;

      if (hasFade) {
        currentVolume = this.nextVolume();
      }

      const [pl, pr] = this.processStereoSample(left, right, currentVolume);
      samples[idx] = pl;
      if (this.channels > 1) samples[idx + 1] = pr;
    }

    return out;
  }

  /**
   * Process remaining leftover buffer
   * @returns Remaining processed buffer
   */
  public flushBuffer(): Buffer {
    if (!this.leftover || this.leftover.length === 0) {
      return Buffer.alloc(0);
    }

    // Zero-pad leftover to complete one frame
    const pad = this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes);
    const padded = pad < this.frameSizeBytes ? Buffer.concat([this.leftover, Buffer.alloc(pad, 0)]) : this.leftover;

    this.leftover = null;
    return this.processBuffer(padded);
  }
}
