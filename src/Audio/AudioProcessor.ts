import { EventEmitter } from "eventemitter3";

import type { AudioProcessingOptions } from "../Types/index.js";
import type { FilterState } from "../Types/audio.js";

import { VolumeEffect } from "./effects/volume.js";
import { FadeEffect } from "./effects/fade.js";
import { BassEffect } from "./effects/bass.js";
import { TrebleEffect } from "./effects/treble.js";
import { CompressorEffect, compressSample } from "./effects/compressor.js";
import { NormalizerEffect } from "./effects/normalizer.js";

export { compressSample };

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

  private volumeEffect: VolumeEffect;
  private fadeEffect = new FadeEffect();
  private bassEffect = new BassEffect();
  private trebleEffect = new TrebleEffect();
  private compressorEffect: CompressorEffect;
  private normalizerEffect: NormalizerEffect;

  private isDestroyed = false;
  private isWritableEnded = false;

  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly frameSizeBytes: number;
  private leftover: Uint8Array | null = null;
  public cloneInput: boolean;

  get volume(): number {
    return this.volumeEffect.value;
  }
  set volume(v: number) {
    this.volumeEffect.set(v);
  }

  get bass(): number {
    return this.bassEffect.value;
  }
  set bass(v: number) {
    this.bassEffect.set(v);
  }

  get treble(): number {
    return this.trebleEffect.value;
  }
  set treble(v: number) {
    this.trebleEffect.set(v);
  }

  get compressor(): boolean {
    return this.compressorEffect.enabled;
  }
  set compressor(v: boolean) {
    this.compressorEffect.set(v);
  }

  get normalize(): boolean {
    return this.normalizerEffect.enabled;
  }
  set normalize(v: boolean) {
    this.normalizerEffect.set(v);
  }

  get filterState(): FilterState {
    return {
      bassShelfL: this.bassEffect.shelfL,
      bassShelfR: this.bassEffect.shelfR,
      bassPeakL: this.bassEffect.peakL,
      bassPeakR: this.bassEffect.peakR,
      trebleShelfL: this.trebleEffect.shelfL,
      trebleShelfR: this.trebleEffect.shelfR,
      treblePeakL: this.trebleEffect.peakL,
      treblePeakR: this.trebleEffect.peakR,
    };
  }

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
    },
  ) {
    super();

    this.sampleRate = options.sampleRate ?? 48000;
    this.channels = options.channels ?? 2;
    this.frameSizeBytes = this.channels * 2;

    this.volumeEffect = new VolumeEffect(options.volume ?? 1);
    this.bassEffect.set(options.bass ?? 0);
    this.trebleEffect.set(options.treble ?? 0);
    this.compressorEffect = new CompressorEffect(!!options.compressor);
    this.normalizerEffect = new NormalizerEffect(!!options.normalize);
    this.cloneInput = options.cloneInput ?? false;

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        if (this.isTerminated()) return;
        const input = this.leftover
          ? concatUint8([this.leftover, chunk])
          : chunk;
        const aligned = this.splitAligned(input);
        this.leftover = aligned.remainder;

        if (aligned.aligned.length > 0) {
          controller.enqueue(this.processPcmBufferAligned(aligned.aligned));
        }
      },
      flush: (controller) => {
        if (this.leftover && this.leftover.length > 0) {
          const padBytes =
            (this.frameSizeBytes -
              (this.leftover.length % this.frameSizeBytes)) %
            this.frameSizeBytes;
          const padded = padBytes
            ? concatUint8([this.leftover, new Uint8Array(padBytes)])
            : this.leftover;
          this.leftover = null;
          controller.enqueue(this.processPcmBufferAligned(padded));
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
    this.volumeEffect.set(volume);
  }

  public startFade(targetVolume: number, durationMs: number): void {
    if (this.isTerminated()) return;
    const evt = this.fadeEffect.start(
      targetVolume,
      durationMs,
      this.volumeEffect.value,
      this.sampleRate,
    );
    this.emit("fade-start", { ...evt, durationMs });
  }

  public setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isTerminated()) return;
    this.bassEffect.set(bass);
    this.trebleEffect.set(treble);
    this.compressorEffect.set(compressor);
  }

  public setCompressor(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.compressorEffect.set(enabled);
  }

  public setNormalize(enabled: boolean): void {
    if (this.isTerminated()) return;
    this.normalizerEffect.set(enabled);
  }

  private shouldBypass(): boolean {
    return (
      !this.fadeEffect.active &&
      !this.normalizerEffect.enabled &&
      this.volumeEffect.value === 1 &&
      Math.abs(this.bassEffect.value) < 1e-6 &&
      Math.abs(this.trebleEffect.value) < 1e-6 &&
      !this.compressorEffect.enabled
    );
  }

  private isTerminated(): boolean {
    return this.isDestroyed || this.isWritableEnded;
  }

  private processStereoSample(
    left: number,
    right: number,
    volume: number,
  ): [number, number] {
    let l = (left * volume) / 32768;
    let r = (right * volume) / 32768;

    [l, r] = this.bassEffect.processStereo(
      l,
      r,
      this.channels,
      this.sampleRate,
    );
    [l, r] = this.trebleEffect.processStereo(
      l,
      r,
      this.channels,
      this.sampleRate,
    );

    if (this.compressorEffect.enabled) {
      l = compressSample(l);
      if (this.channels > 1) r = compressSample(r);
    }

    l = l < -1 ? -1 : l > 1 ? 1 : l;
    r = r < -1 ? -1 : r > 1 ? 1 : r;

    const outL = (l * 32767 + (l < 0 ? -0.5 : 0.5)) | 0;
    const outR = (r * 32767 + (r < 0 ? -0.5 : 0.5)) | 0;

    return [outL, outR];
  }

  private processPcmBufferAligned(buffer: Uint8Array): Uint8Array {
    if (buffer.length === 0) return buffer;
    if (this.shouldBypass()) return buffer;

    const needSlice = this.cloneInput || buffer.byteOffset % 2 !== 0;
    const out = needSlice ? buffer.slice() : buffer;
    const samples = new Int16Array(
      out.buffer,
      out.byteOffset,
      out.byteLength / 2,
    );

    const frameCount = out.byteLength / this.frameSizeBytes;
    let currentVolume = this.volumeEffect.value;

    const normalizeScale = this.normalizerEffect.calculateScale(samples);

    let fadeFinishedEvent: { to: number } | null = null;

    for (let frame = 0; frame < frameCount; frame++) {
      const idx = frame * this.channels;
      const left = samples[idx]!;
      const right = this.channels > 1 ? samples[idx + 1]! : left;

      if (this.fadeEffect.active) {
        const fadeRes = this.fadeEffect.next(currentVolume);
        currentVolume = fadeRes.volume;
        if (fadeRes.justFinished) {
          this.volumeEffect.value = this.fadeEffect.to;
          fadeFinishedEvent = { to: this.fadeEffect.to };
        }
      }

      let [pl, pr] = this.processStereoSample(left, right, currentVolume);

      if (this.normalizerEffect.enabled && normalizeScale !== 1) {
        pl = (pl * normalizeScale) | 0;
        if (this.channels > 1) pr = (pr * normalizeScale) | 0;
      }

      samples[idx] = pl;
      if (this.channels > 1) samples[idx + 1] = pr;
    }

    if (fadeFinishedEvent) {
      this.emit("fade-end", fadeFinishedEvent);
    }

    return out;
  }

  private splitAligned(input: Uint8Array): {
    aligned: Uint8Array;
    remainder: Uint8Array | null;
  } {
    const remainderBytes = input.length % this.frameSizeBytes;
    const alignedBytes = input.length - remainderBytes;
    if (alignedBytes === 0)
      return { aligned: new Uint8Array(0), remainder: input };

    const aligned = input.subarray(0, alignedBytes);
    const remainder = remainderBytes > 0 ? input.subarray(alignedBytes) : null;
    return { aligned, remainder };
  }

  public processBuffer(buffer: Uint8Array): Uint8Array {
    if (this.isTerminated() || buffer.length === 0) return new Uint8Array(0);
    const input = this.leftover ? concatUint8([this.leftover, buffer]) : buffer;
    const { aligned, remainder } = this.splitAligned(input);
    this.leftover = remainder;

    if (aligned.length === 0) return new Uint8Array(0);
    return this.processPcmBufferAligned(aligned);
  }

  public flushBuffer(): Uint8Array {
    if (this.isTerminated() || !this.leftover || this.leftover.length === 0) {
      this.leftover = null;
      return new Uint8Array(0);
    }
    const padBytes =
      (this.frameSizeBytes - (this.leftover.length % this.frameSizeBytes)) %
      this.frameSizeBytes;
    const padded = padBytes
      ? concatUint8([this.leftover, new Uint8Array(padBytes)])
      : this.leftover;
    this.leftover = null;
    return this.processPcmBufferAligned(padded);
  }

  private setupEventHandlers(): void {
    this.on("close", () => {
      this.isDestroyed = true;
      this.leftover = null;
    });
  }
}
