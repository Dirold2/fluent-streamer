import { AudioProcessor } from "../src/Audio/AudioProcessor.js";
import { describe, expect, it, vi } from "vitest";
import { BassEffect } from "../src/Audio/effects/bass.js";
import { MidsEffect } from "../src/Audio/effects/mids.js";
import { TrebleEffect } from "../src/Audio/effects/treble.js";
import { auxiliaryPeakGain, EqualizerSmoothing } from "../src/Audio/effects/EqualizerSmoothing.js";
import { calcPeakingCoeffs } from "../src/Audio/AudioBiquad.js";
import type { BiquadCoeffs } from "../src/Types/audio.js";

describe("AudioProcessor smoothing", () => {
  it.each(["bass", "mids", "treble"] as const)(
    "keeps %s fade-out active until 50 ms of PCM is consumed",
    (band) => {
      const processor = new AudioProcessor({ [band]: 20, channels: 1, sampleRate: 48000 });
      const frequency = { bass: 120, mids: 1000, treble: 8000 }[band];
      const pcm = () =>
        new Uint8Array(
          Int16Array.from({ length: 1200 }, (_, i) =>
            Math.round(1000 * Math.sin((2 * Math.PI * frequency * i) / 48000)),
          ).buffer,
        );
      processor.processBuffer(pcm());
      processor[band] = 0;
      expect(processor[band]).toBe(0);
      expect(processor.processBuffer(pcm())).not.toEqual(pcm());
      processor.processBuffer(pcm());
      expect(processor.processBuffer(pcm())).toEqual(pcm());
    },
  );
});

for (const Effect of [BassEffect, MidsEffect, TrebleEffect]) {
  describe(Effect.name, () => {
    it("keeps immediate setters and exposes the normalized target immediately", () => {
      const initial = new Effect(20);
      const explicit = new Effect();
      explicit.set(20);
      expect(initial.value).toBe(1);
      expect(initial.processStereo(0.1, -0.2, 2, 48000)).toEqual(
        explicit.processStereo(0.1, -0.2, 2, 48000),
      );
      const effect = new Effect();
      expect(effect.active).toBe(false);
      expect(effect.processStereo(0.2, -0.3, 2, 48000)).toEqual([0.2, -0.3]);
      effect.set(100);
      expect(effect.value).toBe(1);
      expect(effect.active).toBe(true);
      effect.processStereo(0.1, 0, 2, 48000);
      effect.set(0);
      expect(effect.active).toBe(false);
      expect(effect.coeffs).toBeNull();
      expect(effect.processStereo(0.2, -0.3, 2, 48000)).toEqual([0.2, -0.3]);
      effect.set(-100, 50);
      expect(effect.value).toBe(-1);
      expect(effect.active).toBe(true);
    });

    it.each([8000, 44100, 48000, 96000])(
      "finishes a fade to bypass in audio frames at %i Hz",
      (rate) => {
        const effect = new Effect();
        effect.set(20);
        for (let i = 0; i < 500; i++) effect.processStereo(0.1, -0.1, 2, rate);
        effect.set(0, 50);
        expect(effect.value).toBe(0);
        const frames = Math.round(rate * 0.05);
        for (let i = 0; i < frames; i++) {
          expect(effect.active).toBe(true);
          const [l, r] = effect.processStereo(0.1, -0.1, 2, rate);
          expect(Number.isFinite(l) && Number.isFinite(r)).toBe(true);
        }
        expect(effect.active).toBe(false);
        expect(effect.processStereo(0.12, -0.2, 2, rate)).toEqual([0.12, -0.2]);
      },
    );

    it("does not advance per channel or chunk, and keeps silent channels silent", () => {
      const whole = new Effect();
      const split = new Effect();
      const mono = new Effect();
      for (const effect of [whole, split, mono]) effect.set(20, 50);
      const expected: number[] = [];
      for (let i = 0; i < 2400; i++) {
        const input = Math.sin(i * 0.17) * 0.1;
        const [l, r] = whole.processStereo(input, 0, 2, 48000);
        expected.push(l);
        expect(r).toBe(0);
        const [m, untouched] = mono.processStereo(input, 0.7, 1, 48000);
        expect(m).toBe(l);
        expect(untouched).toBe(0.7);
      }
      let frame = 0;
      for (const chunk of [1, 31, 97, 3, 2268]) {
        for (let i = 0; i < chunk; i++, frame++) {
          expect(split.processStereo(Math.sin(frame * 0.17) * 0.1, 0, 2, 48000)[0]).toBe(
            expected[frame],
          );
        }
      }
    });

    it("retargets from the running curve rather than jumping to either target", () => {
      const changed = new Effect();
      const reference = new Effect();
      for (const effect of [changed, reference]) effect.set(20, 50);
      for (let i = 0; i < 1000; i++) {
        changed.processStereo(0.1, 0.1, 2, 48000);
        reference.processStereo(0.1, 0.1, 2, 48000);
      }
      changed.set(-20, 50);
      const next = changed.processStereo(0.1, 0.1, 2, 48000)[0];
      const continued = reference.processStereo(0.1, 0.1, 2, 48000)[0];
      expect(Math.abs(next - continued)).toBeLessThan(0.002);
      changed.set(0, 50);
      for (let i = 0; i < 2400; i++) changed.processStereo(0, 0, 2, 48000);
      expect(changed.active).toBe(false);
    });

    it.each([1000, 8000, 48000, 96000])(
      "stays bounded during rapid boost/cut automation at %i Hz",
      (rate) => {
        const effect = new Effect();
        for (let i = 0; i < rate / 2; i++) {
          if (i % 173 === 0) effect.set(i % 346 === 0 ? 20 : -20, 50);
          const input = Math.sin(i * 0.13) * 0.05;
          const [l, r] = effect.processStereo(input, -input, 2, rate);
          expect(Number.isFinite(l)).toBe(true);
          expect(Math.abs(l)).toBeLessThan(2);
          expect(r + l).toBe(0);
          const coeffs = effect.coeffs!;
          const sections = "shelf" in coeffs ? [coeffs.shelf, coeffs.peak!] : [coeffs];
          for (const c of sections) {
            expect(Math.abs(c.a2)).toBeLessThan(1);
            expect(1 + c.a1 + c.a2).toBeGreaterThan(0);
            expect(1 - c.a1 + c.a2).toBeGreaterThan(0);
          }
        }
      },
    );
  });
}

describe("equalizer control ramp", () => {
  it("only designs coefficients at control points and reaches the exact endpoint", () => {
    const design = vi.fn((gain: number, rate: number) => [
      calcPeakingCoeffs(1000, rate, gain, 0.7),
    ]);
    const smoothing = new EqualizerSmoothing(design);
    smoothing.set(12, 50);
    let coeffs: BiquadCoeffs[] = [];
    for (let i = 0; i < 2400; i++) coeffs = smoothing.next(48000);
    expect(design).toHaveBeenCalledTimes(76);
    expect(coeffs).toEqual([calcPeakingCoeffs(1000, 48000, 12, 0.7)]);
    for (let i = 0; i < 100; i++) smoothing.next(48000);
    expect(design).toHaveBeenCalledTimes(76);
  });

  it("preserves remaining wall duration when sample rate changes", () => {
    const smoothing = new EqualizerSmoothing((gain, rate) => [
      calcPeakingCoeffs(100, rate, gain, 0.7),
    ]);
    smoothing.set(12, 0);
    smoothing.next(48000);
    smoothing.set(0, 50);
    for (let i = 0; i < 1200; i++) smoothing.next(48000);
    for (let i = 0; i < 400; i++) {
      expect(smoothing.active).toBe(true);
      smoothing.next(16000);
    }
    expect(smoothing.active).toBe(false);
  });

  it("introduces the auxiliary peaks continuously at both thresholds", () => {
    for (const [threshold, amount] of [
      [6, 0.5],
      [3, 0.3],
    ]) {
      for (const sign of [-1, 1]) {
        expect(Math.abs(auxiliaryPeakGain(sign * threshold!, threshold!, amount!))).toBe(0);
        expect(
          Math.abs(auxiliaryPeakGain(sign * (threshold! + 0.00001), threshold!, amount!)),
        ).toBeLessThan(1e-8);
        expect(auxiliaryPeakGain(sign * (threshold! + 1), threshold!, amount!)).toBe(
          sign * (threshold! + 1) * amount!,
        );
      }
    }
  });
});
