import { describe, expect, it } from "vitest";

import { AudioProcessor } from "../src/Audio/AudioProcessor.js";
import { calcHighShelfCoeffs, calcPeakingCoeffs } from "../src/Audio/AudioBiquad.js";
import { NormalizerEffect } from "../src/Audio/effects/normalizer.js";
import { TrebleEffect } from "../src/Audio/effects/treble.js";

function createProcessor(options: Partial<ConstructorParameters<typeof AudioProcessor>[0]> = {}) {
  return new AudioProcessor({
    volume: 1,
    bass: 0,
    treble: 0,
    compressor: false,
    normalize: false,
    ...options,
  });
}

function pcm(samples: number[]): Uint8Array {
  return new Uint8Array(Int16Array.from(samples).buffer);
}

function decode(buffer: Uint8Array): number[] {
  return Array.from(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2));
}

describe("AudioProcessor regressions", () => {
  describe("treble frequencies", () => {
    it.each([-20, 20])(
      "has a finite, decaying impulse response at 16000 Hz (treble %s)",
      (treble) => {
        const effect = new TrebleEffect();
        effect.set(treble);
        let tailPeak = 0;
        for (let i = 0; i < 8192; i++) {
          const [left, right] = effect.processStereo(i === 0 ? 0.1 : 0, 0, 2, 16000);
          expect(Number.isFinite(left)).toBe(true);
          expect(Math.abs(left)).toBeLessThan(2);
          expect(right).toBe(0);
          if (i >= 7936) tailPeak = Math.max(tailPeak, Math.abs(left));
        }
        expect(tailPeak).toBeLessThan(1e-8);
      },
    );

    it.each([8000, 16000, 22050, 24000, 44100, 48000])(
      "keeps both filter frequencies below Nyquist at %s Hz",
      (sampleRate) => {
        const effect = new TrebleEffect();
        effect.set(20);
        effect.processStereo(0.1, 0, 2, sampleRate);
        const scale = Math.min(1, (sampleRate * 0.45) / 12000);
        expect(effect.coeffs?.shelf).toEqual(
          calcHighShelfCoeffs(8000 * scale, sampleRate, 12, 0.7),
        );
        expect(effect.coeffs?.peak).toEqual(
          calcPeakingCoeffs(12000 * scale, sampleRate, 12 * 0.3, 1.2),
        );
      },
    );

    it("processes a long 16 kHz PCM signal without clipping or a persistent tail", () => {
      const processor = createProcessor({ sampleRate: 16000, channels: 1, treble: 20 });
      const signal = Array.from({ length: 16000 }, (_, i) =>
        Math.round(100 * Math.sin((2 * Math.PI * 3000 * i) / 16000)),
      );
      const output = decode(processor.processBuffer(pcm(signal)));
      expect(Math.max(...output.map(Math.abs))).toBeLessThan(2000);
      const tail = decode(processor.processBuffer(pcm(Array.from({ length: 4096 }, () => 0))));
      expect(tail.slice(-256).every((sample) => sample === 0)).toBe(true);
    });
  });

  describe("normalizer saturation", () => {
    it.each([1, 2])(
      "reduces gain immediately after a quiet-to-loud transition (%s channels)",
      (channels) => {
        const processor = createProcessor({ normalize: true, channels });
        processor.processBuffer(pcm([1000, -1000]));
        const output = decode(processor.processBuffer(pcm([30000, -30000])));
        expect(output[0]).toBeGreaterThan(29000);
        expect(output[0]).toBeLessThanOrEqual(29204);
        expect(output[1]).toBe(-output[0]!);
      },
    );

    it("also protects the TransformStream output", async () => {
      const processor = createProcessor({ normalize: true });
      const reader = processor.readable.getReader();
      const writer = processor.writable.getWriter();
      const quietRead = reader.read();
      await writer.write(pcm([1000, -1000]));
      await quietRead;
      const loudRead = reader.read();
      await writer.write(pcm([30000, -30000]));
      const result = await loudRead;
      const output = decode(result.value!);
      expect(output[0]).toBeGreaterThan(29000);
      expect(output[0]).toBeLessThanOrEqual(29204);
      expect(output[1]).toBe(-output[0]!);
      await writer.close();
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
      writer.releaseLock();
    });

    it("does not change in-range normalized samples", () => {
      const processor = createProcessor({ normalize: true });
      const normalizer = new NormalizerEffect(true);
      const scale = normalizer.calculateScale(new Int16Array([1000, -1000]));
      const rounded = Math.trunc((1000 / 32768) * 32767 + 0.5);
      expect(decode(processor.processBuffer(pcm([1000, -1000])))).toEqual([
        Math.trunc(rounded * scale),
        -Math.trunc(rounded * scale),
      ]);
    });
  });

  describe("supported channels", () => {
    it.each([0, -1, 1.5, 3, 6, NaN, Infinity])(
      "rejects unsupported channel count %s even in bypass mode",
      (channels) => {
        expect(() => createProcessor({ channels })).toThrow(RangeError);
        expect(() => createProcessor({ channels })).toThrow(/channels.*1.*2/i);
      },
    );

    it("defaults to stereo and accepts mono", () => {
      expect(createProcessor().getChannels()).toBe(2);
      expect(createProcessor({ channels: 1 }).getChannels()).toBe(1);
    });

    it("keeps independent stereo filter histories across chunks", () => {
      const options = { bass: 20, treble: 20, sampleRate: 16000 };
      const stereo = createProcessor(options);
      const monoL = createProcessor({ ...options, channels: 1 });
      const monoR = createProcessor({ ...options, channels: 1 });
      for (const [left, right] of [
        [
          [1000, 0, 0, 0],
          [0, -500, 0, 0],
        ],
        [Array.from({ length: 64 }, () => 0), Array.from({ length: 64 }, () => 0)],
      ]) {
        const interleaved = left!.flatMap((sample, i) => [sample, right![i]!]);
        const output = decode(stereo.processBuffer(pcm(interleaved)));
        const expectedL = decode(monoL.processBuffer(pcm(left!)));
        const expectedR = decode(monoR.processBuffer(pcm(right!)));
        expect(output).toEqual(expectedL.flatMap((sample, i) => [sample, expectedR[i]!]));
      }
    });
  });
});
