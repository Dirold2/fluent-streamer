import { describe, expect, it } from "vitest";
import { NormalizerEffect } from "../src/Audio/effects/normalizer.js";

const targetPeak = 32767 * 10 ** (-1 / 20);
const block = (peak: number, frames = 4800, channels = 2) =>
  new Int16Array(frames * channels).fill(peak);

describe("NormalizerEffect", () => {
  it("bypasses disabled and empty input", () => {
    expect(new NormalizerEffect(false).calculateScale(block(100))).toBe(1);
    expect(new NormalizerEffect(true).calculateScale(new Int16Array())).toBe(1);
  });

  it("does not boost silence or near-silence", () => {
    const effect = new NormalizerEffect(true);
    for (const peak of [0, 1, -1, 32, -32]) {
      for (let i = 0; i < 10; i++) expect(effect.calculateScale(block(peak))).toBe(1);
    }
  });

  it("limits amplification to four times even after sustained quiet input", () => {
    const effect = new NormalizerEffect(true);
    for (let i = 0; i < 100; i++) {
      const gain = effect.calculateScale(block(100));
      expect(gain).toBeGreaterThanOrEqual(1);
      expect(gain).toBeLessThanOrEqual(4);
    }
    expect(effect.calculateScale(block(100))).toBeCloseTo(4);
  });

  it.each([30000, 32767, -32768])("immediately protects a loud block at peak %i", (peak) => {
    const effect = new NormalizerEffect(true);
    for (let i = 0; i < 100; i++) effect.calculateScale(block(100));
    const gain = effect.calculateScale(block(peak));
    expect(Math.abs(peak) * gain).toBeCloseTo(targetPeak, 6);
  });

  it("recovers gain gradually, with the same time constant across sample rates and channels", () => {
    const gains: number[] = [];
    for (const sampleRate of [16000, 48000]) {
      for (const channels of [1, 2]) {
        const effect = new NormalizerEffect(true);
        effect.calculateScale(block(32767));
        gains.push(
          effect.calculateScale(block(1000, sampleRate / 10, channels), sampleRate, channels),
        );
      }
    }
    for (const gain of gains) expect(gain).toBeCloseTo(gains[0]!, 10);
    expect(gains[0]).toBeGreaterThan(1);
    expect(gains[0]).toBeLessThan(2);
  });

  it("has chunk-size-independent gain recovery for a constant signal", () => {
    const whole = new NormalizerEffect(true);
    const split = new NormalizerEffect(true);
    const expected = whole.calculateScale(block(1000, 48000));
    let actual = 1;
    for (let i = 0; i < 100; i++) actual = split.calculateScale(block(1000, 480));
    expect(actual).toBeCloseTo(expected, 10);
  });

  it("resets gain on silence and enable/disable transitions", () => {
    const effect = new NormalizerEffect(true);
    effect.calculateScale(block(1000, 48000));
    expect(effect.calculateScale(block(0))).toBe(1);
    const initial = effect.calculateScale(block(1000));
    effect.calculateScale(block(1000, 48000));
    effect.set(false);
    effect.set(true);
    expect(effect.calculateScale(block(1000))).toBe(initial);
  });
});
