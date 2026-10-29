import { describe, expect, it, vi } from "vitest";
import { MidsEffect, normalizeMids } from "../src/Audio/effects/mids.js";
import { AudioProcessor } from "../src/Audio/AudioProcessor.js";
import { FluentAudioState } from "../src/Fluent/FluentAudioState.js";
import { FluentStream } from "../src/index.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";

function gainAt(frequency: number, value: number, sampleRate = 48000): number {
  const effect = new MidsEffect();
  effect.set(value);
  let inputEnergy = 0;
  let outputEnergy = 0;
  for (let i = 0; i < sampleRate; i++) {
    const input = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.1;
    const [output] = effect.processStereo(input, 0, 1, sampleRate);
    if (i > sampleRate / 2) {
      inputEnergy += input * input;
      outputEnergy += output * output;
    }
  }
  return Math.sqrt(outputEnergy / inputEnergy);
}

describe("MidsEffect", () => {
  it("normalizes and clamps the same user range as bass and treble", () => {
    expect(normalizeMids(-20)).toBe(-1);
    expect(normalizeMids(0)).toBe(0);
    expect(normalizeMids(20)).toBe(1);
    expect(normalizeMids(-100)).toBe(-1);
    expect(normalizeMids(100)).toBe(1);
  });

  it("bypasses unchanged samples at zero", () => {
    const effect = new MidsEffect();
    expect(effect.processStereo(0.25, -0.5, 2, 48000)).toEqual([0.25, -0.5]);
    expect(effect.coeffs).toBeNull();
  });

  it("boosts and cuts 1 kHz by 12 dB while preserving lows and highs", () => {
    expect(gainAt(1000, 20)).toBeCloseTo(10 ** (12 / 20), 2);
    expect(gainAt(1000, -20)).toBeCloseTo(10 ** (-12 / 20), 2);
    expect(gainAt(50, 20)).toBeLessThan(1.05);
    expect(gainAt(12000, 20)).toBeLessThan(1.05);
  });

  it("keeps channel state independent and leaves the right channel untouched in mono", () => {
    const effect = new MidsEffect();
    effect.set(20);
    for (let i = 0; i < 100; i++) {
      expect(effect.processStereo(i === 0 ? 0.1 : 0, 0, 2, 48000)[1]).toBe(0);
    }
    expect(effect.peakR.y1).toBe(0);
    expect(effect.processStereo(0.1, 0.25, 1, 48000)[1]).toBe(0.25);
  });

  it.each([1000, 8000, 16000, 44100, 48000])("stays finite at sample rate %i", (sampleRate) => {
    const effect = new MidsEffect();
    effect.set(20);
    for (let i = 0; i < sampleRate; i++) {
      const [l, r] = effect.processStereo(i === 0 ? 1 : 0, 0, 2, sampleRate);
      expect(Number.isFinite(l) && Number.isFinite(r)).toBe(true);
    }
  });

  it("invalidates coefficients when value or sample rate changes", () => {
    const effect = new MidsEffect();
    effect.set(10);
    effect.processStereo(0, 0, 2, 48000);
    const first = effect.coeffs;
    effect.processStereo(0, 0, 2, 16000);
    expect(effect.coeffs).not.toBe(first);
    effect.set(-10);
    expect(effect.coeffs).toBeNull();
  });
});

describe("mids integration", () => {
  it("applies constructor options and runtime changes to PCM processing", () => {
    const processor = new AudioProcessor({ mids: 20, channels: 1 });
    expect(processor.mids).toBe(1);
    const source = new Int16Array(4800);
    for (let i = 0; i < source.length; i++)
      source[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 1000;
    const input = new Uint8Array(source.buffer);
    const output = processor.processBuffer(input.slice());
    expect(new Int16Array(output.buffer).some((sample) => Math.abs(sample) > 3000)).toBe(true);
    processor.setMids(0);
    expect(processor.processBuffer(input.slice())).not.toEqual(input);
    expect(processor.processBuffer(input.slice())).toEqual(input);
    expect(processor.filterState.midsPeakL).not.toBe(processor.filterState.midsPeakR);
  });

  it("preserves state between PCM chunks", () => {
    const whole = new AudioProcessor({ mids: 15, channels: 1 });
    const split = new AudioProcessor({ mids: 15, channels: 1 });
    const input = new Uint8Array(new Int16Array([1000, 0, 500, 0, -1000, 0]).buffer);
    const expected = whole.processBuffer(input.slice());
    const result = new Uint8Array([
      ...split.processBuffer(input.slice(0, 4)),
      ...split.processBuffer(input.slice(4)),
    ]);
    expect(result).toEqual(expected);
  });

  it("bridges live changes and retains options for the next run", () => {
    const state = new FluentAudioState({ mids: 5 });
    const setMids = vi.fn();
    state.attachResult({ setMids } as unknown as FFmpegRunResultExtended);
    state.setMids(10);
    expect(setMids).toHaveBeenCalledWith(10);
    state.attachResult(null);
    expect(state.mids).toBe(10);
  });

  it("exposes chainable fluent setters and initial options", () => {
    const fluent = new FluentStream({ audioProcessorOptions: { mids: 5 } });
    expect(fluent.mids).toBe(5);
    expect(fluent.setMids(12)).toBe(fluent);
    expect(fluent.mids).toBe(12);
  });
});
