import { describe, expect, it, vi } from "vitest";
import { AudioProcessor } from "../src/Audio/AudioProcessor.js";
import { KaraokeEffect } from "../src/Audio/effects/karaoke.js";
import { AudioEffectController } from "../src/Audio/AudioEffectController.js";
import { FluentAudioState } from "../src/Fluent/FluentAudioState.js";
import { buildProcessorConfig } from "../src/Core/processor/config.js";
import { createAudioProcessor } from "../src/Core/processor/pipeline.js";
import type { AudioProcessingOptions, FFmpegRunResultExtended } from "../src/Types/index.js";

const defaults: AudioProcessingOptions = {
  volume: 1,
  bass: 0,
  treble: 0,
  compressor: false,
  normalize: false,
};
const pcm = (samples: number[]) => new Uint8Array(new Int16Array(samples).buffer);
const samples = (bytes: Uint8Array) =>
  Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
const processor = (options: Partial<AudioProcessingOptions> = {}) =>
  new AudioProcessor({ ...defaults, ...options });

const sampleRate = 48000;
const rampFrames = sampleRate * 0.05;
const signalFrames = sampleRate * 0.2;

function stereoSignal(frame: (index: number) => [number, number], length = signalFrames): number[] {
  return Array.from({ length }, (_, index) => frame(index)).flat();
}

function sine(index: number): number {
  return Math.round(12000 * Math.sin((2 * Math.PI * 1000 * index) / sampleRate));
}

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function channel(values: number[], side: number, start = 0, end = values.length / 2): number[] {
  return values.slice(start * 2, end * 2).filter((_, index) => index % 2 === side);
}

// AudioProcessor uses normalized float DSP followed by signed 16-bit quantization.
function quantize(value: number): number {
  const normalized = Math.max(-1, Math.min(1, value / 32768));
  return (normalized * 32767 + (normalized < 0 ? -0.5 : 0.5)) | 0;
}

describe("karaoke DSP", () => {
  it("defaults to byte-exact bypass", () => {
    const p = processor();
    const input = pcm([-32768, 32767, 1234, -5678]);
    expect(p.karaoke).toBe(false);
    const original = input.slice();
    expect(p.processBuffer(input)).toEqual(original);
    const effect = new KaraokeEffect();
    expect(effect.enabled).toBe(false);
    expect(effect.active).toBe(false);
    expect(effect.processStereo(1234, -5678, 2)).toEqual([1234, -5678]);
  });

  it("preserves antiphase stereo content and its channel polarity", () => {
    const input = stereoSignal((index) => [sine(index), -sine(index)]);
    const output = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    expect(output).toEqual(input.map(quantize));
  });

  it("filters only mid while preserving side in mixed stereo content", () => {
    const input = stereoSignal((index) => {
      const mid = sine(index);
      const side = Math.round(3000 * Math.sin((2 * Math.PI * 370 * index) / sampleRate));
      return [mid + side, mid - side];
    });
    const output = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    for (let index = 0; index < input.length; index += 2) {
      const originalSide = (input[index]! - input[index + 1]!) / 2;
      const processedSide = (output[index]! - output[index + 1]!) / 2;
      expect(Math.abs(processedSide - originalSide * (32767 / 32768))).toBeLessThanOrEqual(1);
    }
  });

  it("retains centered DC after the center filters settle", () => {
    const input = stereoSignal(() => [12000, 12000]);
    const output = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    for (const value of output.slice(-200)) {
      expect(Math.abs(value - quantize(12000))).toBeLessThanOrEqual(2);
    }
  });

  it("attenuates a centered 1 kHz sine without collapsing stereo side content", () => {
    const input = stereoSignal((index) => [sine(index), sine(index)]);
    const output = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    const settled = sampleRate * 0.1;
    expect(rms(channel(output, 0, settled))).toBeLessThan(rms(channel(input, 0, settled)) * 0.2);
    expect(channel(output, 0)).toEqual(channel(output, 1));
  });

  it.each([0, 1])("retains hard-panned content on channel %i", (side) => {
    const input = stereoSignal((index) => (side === 0 ? [sine(index), 0] : [0, sine(index)]));
    const output = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    expect(output).toEqual(input.map(quantize));
  });

  it("bounds opposite full-scale samples without overflow or phase inversion", () => {
    const input = [32767, -32768, -32768, 32767];
    expect(samples(processor({ karaoke: true }).processBuffer(pcm(input)))).toEqual(
      input.map(quantize),
    );
  });

  it("leaves mono byte-exact, including the negative full-scale endpoint", () => {
    const p = processor({ karaoke: true, channels: 1 });
    const input = pcm([-32768, -12345, 0, 1, 32767]);
    const original = input.slice();
    expect(p.processBuffer(input)).toEqual(original);
    expect(new KaraokeEffect(true, sampleRate).processStereo(-32768, 32767, 1)).toEqual([
      -32768, 32767,
    ]);
  });

  it("does not change other mono effects", () => {
    const input = pcm([-32768, 12000, -5000, 32767]);
    expect(
      processor({ karaoke: true, channels: 1, volume: 0.5 }).processBuffer(input.slice()),
    ).toEqual(processor({ channels: 1, volume: 0.5 }).processBuffer(input.slice()));
  });

  it.each([24000, 48000])("keeps the disabling ramp active for 50 ms at %i Hz", (rate) => {
    const effect = new KaraokeEffect(true, rate);
    expect(effect.enabled).toBe(true);
    expect(effect.active).toBe(true);
    effect.set(false);
    expect(effect.enabled).toBe(false);
    expect(effect.active).toBe(true);
    const frames = rate * 0.05;
    for (let index = 0; index < frames / 2; index++) {
      effect.processStereo(sine(index), sine(index), 2);
    }
    expect(effect.active).toBe(true);
    for (let index = frames / 2; index <= frames; index++) {
      effect.processStereo(sine(index), sine(index), 2);
    }
    expect(effect.active).toBe(false);
    expect(effect.processStereo(12345, -6789, 2)).toEqual([12345, -6789]);
  });

  it("enables immediately in the constructor but ramps runtime method and property toggles", () => {
    const input = stereoSignal((index) => [sine(index), sine(index)]);
    const immediate = samples(processor({ karaoke: true }).processBuffer(pcm(input)));
    const p = processor();
    p.setKaraoke(true);
    expect(p.karaoke).toBe(true);
    const enabled = samples(p.processBuffer(pcm(input)));
    const dryRms = rms(channel(input, 0, 0, 240));
    expect(rms(channel(enabled, 0, 0, 240))).toBeGreaterThan(dryRms * 0.8);
    expect(rms(channel(immediate, 0, 0, 240))).toBeLessThan(dryRms * 0.3);
    expect(rms(channel(enabled, 0, 960, 1440))).toBeLessThan(dryRms * 0.8);
    expect(rms(channel(enabled, 0, 960, 1440))).toBeGreaterThan(dryRms * 0.3);
    expect(rms(channel(enabled, 0, rampFrames * 2))).toBeLessThan(dryRms * 0.2);

    p.karaoke = false;
    expect(p.karaoke).toBe(false);
    const disabled = samples(p.processBuffer(pcm(input)));
    expect(rms(channel(disabled, 0, 0, 240))).toBeLessThan(dryRms * 0.3);
    expect(rms(channel(disabled, 0, 960, 1440))).toBeGreaterThan(dryRms * 0.3);
    expect(rms(channel(disabled, 0, 960, 1440))).toBeLessThan(dryRms * 0.8);
    const bypass = pcm([-32768, 32767, 12345, -6789]);
    expect(p.processBuffer(bypass.slice())).toEqual(bypass);

    p.karaoke = true;
    expect(p.karaoke).toBe(true);
    const reenabled = samples(p.processBuffer(pcm(input)));
    expect(rms(channel(reenabled, 0, 0, 240))).toBeGreaterThan(dryRms * 0.8);
    expect(rms(channel(reenabled, 0, rampFrames * 2))).toBeLessThan(dryRms * 0.2);
  });

  it("preserves cloneInput and supports unaligned byte offsets", () => {
    const input = pcm(stereoSignal((index) => [sine(index), Math.round(sine(index) / 3)]));
    const original = input.slice();
    const expected = processor({ karaoke: true }).processBuffer(input.slice());
    const output = processor({ karaoke: true, cloneInput: true }).processBuffer(input);
    expect(output).toEqual(expected);
    expect(input).toEqual(original);
    const backing = new Uint8Array(input.length + 2);
    backing.fill(0x5a);
    backing.set(input, 1);
    expect(
      processor({ karaoke: true }).processBuffer(backing.subarray(1, 1 + input.length)),
    ).toEqual(expected);
    expect(backing.subarray(1, 1 + input.length)).toEqual(original);
    expect(backing[0]).toBe(0x5a);
    expect(backing[backing.length - 1]).toBe(0x5a);
  });

  it("is invariant across arbitrary chunk boundaries and pads incomplete frames", () => {
    const input = pcm(stereoSignal((index) => [sine(index), Math.round(sine(index) / 3)]));
    const expected = processor({ karaoke: true }).processBuffer(input.slice());
    const p = processor({ karaoke: true });
    const chunks: Uint8Array[] = [];
    const sizes = [1, 6, 191, 4097, 2, 37];
    for (let offset = 0, index = 0; offset < input.length; index++) {
      const size = sizes[index % sizes.length]!;
      chunks.push(p.processBuffer(input.slice(offset, offset + size)));
      offset += size;
    }
    chunks.push(p.flushBuffer());
    expect(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)))).toEqual(expected);
    const partial = processor({ karaoke: true });
    expect(partial.processBuffer(pcm([1000]))).toHaveLength(0);
    expect(partial.flushBuffer()).toEqual(
      processor({ karaoke: true }).processBuffer(pcm([1000, 0])),
    );
    expect(partial.flushBuffer()).toHaveLength(0);
  });

  it("processes TransformStream input and ignores updates after termination", async () => {
    const p = processor({ karaoke: true });
    const output: number[] = [];
    const drain = p.readable.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          output.push(...samples(chunk));
        },
      }),
    );
    const writer = p.writable.getWriter();
    const input = pcm(stereoSignal((index) => [sine(index), Math.round(sine(index) / 3)]));
    const expected = samples(processor({ karaoke: true }).processBuffer(input.slice()));
    await writer.write(input.slice(0, 3));
    await writer.write(input.slice(3));
    await writer.close();
    await drain;
    expect(output).toEqual(expected);
    p.setKaraoke(false);
    expect(p.karaoke).toBe(true);
    const closed = processor();
    closed.emit("close");
    closed.karaoke = true;
    expect(closed.karaoke).toBe(false);
  });
});

describe("karaoke runtime integration", () => {
  it("bridges controller updates and guards closed processors", () => {
    const p = processor();
    const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const controller = new AudioEffectController(
      p,
      { logger, loggerTag: "test", verbose: true },
      defaults,
    );
    controller.setKaraoke(true);
    expect(p.karaoke).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Karaoke changed: false → true"),
    );
    p.emit("close");
    controller.setKaraoke(false);
    expect(p.karaoke).toBe(true);
  });

  it("persists initial state, invalidates cached options and bridges live updates", () => {
    const state = new FluentAudioState({ karaoke: true });
    const first = state.buildOptions();
    expect(first.karaoke).toBe(true);
    expect(state.buildOptions()).toBe(first);
    expect(state.debugInfo().karaoke).toBe(true);
    expect(state.changeKaraoke(false)).toBe(false);
    expect(state.karaoke).toBe(true);
    expect(state.setKaraoke(false)).toBe(state);
    expect(state.buildOptions()).not.toBe(first);
    expect(state.buildOptions().karaoke).toBe(false);
    const setKaraoke = vi.fn();
    state.attachResult({ setKaraoke } as unknown as FFmpegRunResultExtended);
    expect(state.changeKaraoke(true)).toBe(true);
    expect(setKaraoke).toHaveBeenLastCalledWith(true);
    expect(state.setKaraoke(false)).toBe(state);
    expect(setKaraoke).toHaveBeenLastCalledWith(false);
    state.attachResult(null);
    state.setKaraoke(true);
    expect(state.buildOptions().karaoke).toBe(true);
  });

  it("propagates pipeline configuration only when processing is enabled", () => {
    const config = buildProcessorConfig({ audioProcessorOptions: { ...defaults, karaoke: true } });
    expect(createAudioProcessor(config, true, 1, 0, 0, false).karaoke).toBe(true);
    expect(createAudioProcessor(config, false, 1, 0, 0, false).karaoke).toBe(false);
    expect(createAudioProcessor(config, true, 1, 0, 0, false, 0, false).karaoke).toBe(false);
  });
});
