import { EventEmitter } from "eventemitter3";

import type { AudioProcessingOptions } from "../Types/index.js";
import type { BiquadCoeffs, BiquadState, FilterState } from "../Types/audio.js";
import {
  VOLUME_MIN,
  VOLUME_MAX,
  BASS_MIN,
  BASS_MAX,
  TREBLE_MIN,
  TREBLE_MAX,
} from "../Types/audio.js";

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

export function calcLowShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 - (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
  const b2 = A * (A + 1 - (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 + (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = -2 * (A - 1 + (A + 1) * cosW0);
  const a2 = A + 1 + (A - 1) * cosW0 - sqrtA2Alpha;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

export function calcHighShelfCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q = 0.7,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / Q - 1) + 2);
  const sqrtA2Alpha = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cosW0 + sqrtA2Alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
  const b2 = A * (A + 1 + (A - 1) * cosW0 - sqrtA2Alpha);
  const a0 = A + 1 - (A - 1) * cosW0 + sqrtA2Alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosW0);
  const a2 = A + 1 - (A - 1) * cosW0 - sqrtA2Alpha;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

export function calcPeakingCoeffs(
  freq: number,
  sampleRate: number,
  gainDb: number,
  Q: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

export function processBiquad(input: number, coeffs: BiquadCoeffs, state: BiquadState): number {
  const output =
    coeffs.b0 * input +
    coeffs.b1 * state.x1 +
    coeffs.b2 * state.x2 -
    coeffs.a1 * state.y1 -
    coeffs.a2 * state.y2;

  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;

  return output;
}

function initBiquadState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function concatUint8(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export class AudioProcessor extends EventEmitter {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  public volume: number;
  public bass: number;
  public treble: number;
  public compressor: boolean;
  public normalize: boolean;

  public filterState: FilterState = {
    bassShelfL: initBiquadState(),
    bassShelfR: initBiquadState(),
    bassPeakL: initBiquadState(),
    bassPeakR: initBiquadState(),
    trebleShelfL: initBiquadState(),
    trebleShelfR: initBiquadState(),
    treblePeakL: initBiquadState(),
    treblePeakR: initBiquadState(),
  };

  private bassCoeffs: {
    shelf: BiquadCoeffs;
    peak: BiquadCoeffs | null;
  } | null = null;
  private trebleCoeffs: {
    shelf: BiquadCoeffs;
    peak: BiquadCoeffs | null;
  } | null = null;

  private isDestroyed = false;
  private isWritableEnded = false;
  private fadeActive = false;
  private fadeFrom = 1;
  private fadeTo = 1;
  private fadeSamplesTotal = 0;
  private fadeSamplesDone = 0;

  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly frameSizeBytes: number;
  private leftover: Uint8Array | null = null;

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  get writableEnded(): boolean {
    return this.isWritableEnded;
  }

  constructor(
    options: AudioProcessingOptions & {
      sampleRate?: number;
      channels?: number;
    } = {
      volume: 1,
      bass: 0,
      treble: 0,
      compressor: false,
      normalize: false,
      sampleRate: 48000,
      channels: 2,
    },
  ) {
    super();

    this.sampleRate = options.sampleRate ?? 48000;
    this.channels = options.channels ?? 2;
    this.frameSizeBytes = this.channels * 2;

    this.volume = clampVolume(options.volume ?? 1);
    this.bass = normalizeBass(options.bass ?? 0);
    this.treble = normalizeTreble(options.treble ?? 0);
    this.compressor = !!options.compressor;
    this.normalize = !!options.normalize;

    this.invalidateCoeffs();

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        if (this.isTerminated()) return;

        const input = this.leftover ? concatUint8([this.leftover, chunk]) : chunk;

        const aligned = this.splitAligned(input);
        this.leftover = aligned.remainder;

        if (aligned.aligned.length > 0) {
          const processed = this.processPcmBufferAligned(aligned.aligned);
          controller.enqueue(processed);
        }
      },
      flush: (controller) => {
        if (this.leftover && this.leftover.length > 0) {
          const padBytes =
            (this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes)) %
            this.frameSizeBytes;

          const padded = padBytes
            ? concatUint8([this.leftover, new Uint8Array(padBytes)])
            : this.leftover;

          this.leftover = null;

          const processed = this.processPcmBufferAligned(padded);
          if (processed.length > 0) {
            controller.enqueue(processed);
          }
        }
        this.isWritableEnded = true;
      },
    });

    this.readable = transform.readable;
    this.writable = transform.writable;

    this.setupEventHandlers();
  }

  public getSampleRate(): number {
    return this.sampleRate;
  }

  public getChannels(): number {
    return this.channels;
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

    this.emit("fade-start", {
      from: this.fadeFrom,
      to: this.fadeTo,
      durationMs,
    });
  }

  public setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isTerminated()) return;
    this.bass = normalizeBass(bass);
    this.treble = normalizeTreble(treble);
    this.compressor = compressor;
    this.invalidateCoeffs();
  }

  public setCompressor(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.compressor = enabled;
  }

  public setNormalize(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.normalize = enabled;
  }

  private shouldBypass(): boolean {
    return (
      !this.fadeActive &&
      !this.normalize &&
      this.volume === 1 &&
      Math.abs(this.bass) < 1e-6 &&
      Math.abs(this.treble) < 1e-6 &&
      !this.compressor
    );
  }

  private isTerminated(): boolean {
    return this.isDestroyed || this.isWritableEnded;
  }

  private invalidateCoeffs(): void {
    this.bassCoeffs = null;
    this.trebleCoeffs = null;
  }

  private nextVolume(): number {
    if (!this.fadeActive) return this.volume;

    const progress =
      this.fadeSamplesTotal > 0 ? Math.min(1, this.fadeSamplesDone / this.fadeSamplesTotal) : 1;

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

  private processStereoSample(left: number, right: number, volume: number): [number, number] {
    let l = (left * volume) / 32768;
    let r = (right * volume) / 32768;

    if (Math.abs(this.bass) > 0.001) {
      [l, r] = this.applyBassFilter(l, r);
    }

    if (Math.abs(this.treble) > 0.001) {
      [l, r] = this.applyTrebleFilter(l, r);
    }

    if (this.compressor) {
      l = compressSample(l);
      r = compressSample(r);
    }

    l = l < -1 ? -1 : l > 1 ? 1 : l;
    r = r < -1 ? -1 : r > 1 ? 1 : r;

    const outL = (l * 32767 + (l < 0 ? -0.5 : 0.5)) | 0;
    const outR = (r * 32767 + (r < 0 ? -0.5 : 0.5)) | 0;

    return [outL, outR];
  }

  private applyBassFilter(l: number, r: number): [number, number] {
    if (!this.bassCoeffs) {
      const gainDb = userToGainDb(this.bass, 18);
      const shelf = calcLowShelfCoeffs(120, this.sampleRate, gainDb, 0.7);
      let peak: BiquadCoeffs | null = null;
      if (Math.abs(gainDb) > 6) {
        peak = calcPeakingCoeffs(60, this.sampleRate, gainDb * 0.5, 1.0);
      }
      this.bassCoeffs = { shelf, peak };
    }

    l = processBiquad(l, this.bassCoeffs.shelf, this.filterState.bassShelfL);
    r = processBiquad(r, this.bassCoeffs.shelf, this.filterState.bassShelfR);

    if (this.bassCoeffs.peak) {
      l = processBiquad(l, this.bassCoeffs.peak, this.filterState.bassPeakL);
      r = processBiquad(r, this.bassCoeffs.peak, this.filterState.bassPeakR);
    }

    return [l, r];
  }

  private applyTrebleFilter(l: number, r: number): [number, number] {
    if (!this.trebleCoeffs) {
      const gainDb = userToGainDb(this.treble, 12);
      const shelf = calcHighShelfCoeffs(8000, this.sampleRate, gainDb, 0.7);
      let peak: BiquadCoeffs | null = null;
      if (gainDb > 3) {
        peak = calcPeakingCoeffs(12000, this.sampleRate, gainDb * 0.3, 1.2);
      }
      this.trebleCoeffs = { shelf, peak };
    }

    l = processBiquad(l, this.trebleCoeffs.shelf, this.filterState.trebleShelfL);
    r = processBiquad(r, this.trebleCoeffs.shelf, this.filterState.trebleShelfR);

    if (this.trebleCoeffs.peak) {
      l = processBiquad(l, this.trebleCoeffs.peak, this.filterState.treblePeakL);
      r = processBiquad(r, this.trebleCoeffs.peak, this.filterState.treblePeakR);
    }

    return [l, r];
  }

  private setupEventHandlers(): void {
    this.on("close", () => {
      this.isDestroyed = true;
      this.leftover = null;
    });
  }

  private processPcmBufferAligned(buffer: Uint8Array): Uint8Array {
    if (buffer.length === 0) return buffer;
    if (this.shouldBypass()) {
      return buffer;
    }

    let out = buffer;

    if (out.byteOffset % 2 !== 0) {
      out = out.slice();
    }

    const samples = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);

    const frameCount = out.byteLength / this.frameSizeBytes;
    const hasFade = this.fadeActive;
    let currentVolume = this.volume;

    let normalizeScale = 1;
    if (this.normalize) {
      let peak = 0;
      const totalSamples = samples.length;
      for (let i = 0; i < totalSamples; i++) {
        const v = samples[i]!;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }

      if (peak > 0) {
        normalizeScale = 32767 / peak;
      }
    }

    for (let frame = 0; frame < frameCount; frame++) {
      const idx = frame * this.channels;
      const left = samples[idx]!;
      const right = samples[idx + 1] ?? left;

      if (hasFade) {
        currentVolume = this.nextVolume();
      }

      let [pl, pr] = this.processStereoSample(left, right, currentVolume);

      if (this.normalize && normalizeScale !== 1) {
        pl = (pl * normalizeScale) | 0;
        pr = (pr * normalizeScale) | 0;
      }

      samples[idx] = pl;
      if (this.channels > 1) {
        samples[idx + 1] = pr;
      }
    }

    return out;
  }

  private splitAligned(input: Uint8Array): {
    aligned: Uint8Array;
    remainder: Uint8Array | null;
  } {
    const remainderBytes = input.length % this.frameSizeBytes;
    const alignedBytes = input.length - remainderBytes;

    if (alignedBytes === 0) {
      return { aligned: new Uint8Array(0), remainder: input };
    }

    const aligned = input.subarray(0, alignedBytes);
    const remainder = remainderBytes > 0 ? input.subarray(alignedBytes) : null;

    return { aligned, remainder };
  }

  public processBuffer(buffer: Uint8Array): Uint8Array {
    if (this.isTerminated()) {
      return new Uint8Array(0);
    }

    if (buffer.length === 0) {
      return new Uint8Array(0);
    }

    const input = this.leftover ? concatUint8([this.leftover, buffer]) : buffer;

    const { aligned, remainder } = this.splitAligned(input);
    this.leftover = remainder;

    if (aligned.length === 0) {
      return new Uint8Array(0);
    }

    return this.processPcmBufferAligned(aligned);
  }

  public flushBuffer(): Uint8Array {
    if (this.isTerminated()) {
      this.leftover = null;
      return new Uint8Array(0);
    }

    if (!this.leftover || this.leftover.length === 0) {
      return new Uint8Array(0);
    }

    const padBytes =
      (this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes)) % this.frameSizeBytes;

    const padded = padBytes
      ? concatUint8([this.leftover, new Uint8Array(padBytes)])
      : this.leftover;

    this.leftover = null;

    return this.processPcmBufferAligned(padded);
  }
}
