import { describe, expect, it } from "vitest";
import { KaraokeEffect } from "../src/Audio/effects/karaoke.js";

function gain(frequency: number, sampleRate = 48000): number {
  const effect = new KaraokeEffect(true, sampleRate);
  let inputEnergy = 0,
    outputEnergy = 0;
  for (let i = 0; i < sampleRate; i++) {
    const input = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    const [left, right] = effect.processStereo(input, input, 2);
    expect(Number.isFinite(left) && Number.isFinite(right)).toBe(true);
    if (i > sampleRate / 2) {
      inputEnergy += input * input;
      outputEnergy += left * left;
    }
  }
  return Math.sqrt(outputEnergy / inputEnergy);
}

describe("KaraokeEffect", () => {
  it("strongly attenuates centered vocal-range tones", () => {
    for (const frequency of [500, 1000, 2000]) expect(gain(frequency)).toBeLessThan(0.12);
  });

  it("retains low bass and high treble instead of removing the entire center", () => {
    expect(gain(30)).toBeGreaterThan(0.85);
    expect(gain(16000)).toBeGreaterThan(0.8);
  });

  it("preserves hard-panned content and stereo side signal", () => {
    const effect = new KaraokeEffect(true);
    for (let i = 0; i < 5000; i++) {
      const value = Math.sin(i * 0.1);
      expect(effect.processStereo(value, 0, 2)).toEqual([value, 0]);
    }
    const side = new KaraokeEffect(true);
    expect(side.processStereo(0.75, -0.75, 2)).toEqual([0.75, -0.75]);
  });

  it("ramps runtime changes over 50ms and returns to exact bypass", () => {
    const effect = new KaraokeEffect(false, 1000);
    effect.set(true);
    const first = effect.processStereo(1, 1, 2)[0];
    expect(Math.abs(first - 1)).toBeLessThan(0.02);
    for (let i = 0; i < 50; i++) effect.processStereo(1, 1, 2);
    effect.set(false);
    expect(effect.enabled).toBe(false);
    expect(effect.active).toBe(true);
    for (let i = 0; i < 50; i++) effect.processStereo(1, 1, 2);
    expect(effect.active).toBe(false);
    expect(effect.processStereo(0.4, -0.2, 2)).toEqual([0.4, -0.2]);
  });

  it("leaves mono unchanged", () => {
    expect(new KaraokeEffect(true).processStereo(12000, 12000, 1)).toEqual([12000, 12000]);
  });

  it("remains finite at low supported rates", () => {
    for (const rate of [8000, 16000, 44100, 96000]) expect(gain(1000, rate)).toBeLessThan(1);
  });

  it("rejects invalid sample rates", () => {
    for (const rate of [0, -1, NaN, Infinity])
      expect(() => new KaraokeEffect(true, rate)).toThrow(RangeError);
  });
});
