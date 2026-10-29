import { describe, expect, it } from "vitest";
import { evaluateGridStability } from "../src/Audio/analysis/GridStability.js";

function beats(duration: number, period = 0.6, phase = 0.2): number[] {
  return Array.from(
    { length: Math.max(0, Math.ceil((duration - phase) / period)) },
    (_, index) => phase + index * period,
  ).filter((time) => time < duration);
}

describe("evaluateGridStability", () => {
  it("measures stable signed offsets and deterministic balanced jitter", () => {
    const onsets = beats(30, 0.5, 0.2).map(
      (time, index) => time + 0.02 + (index % 2 ? 0.002 : -0.002),
    );
    const result = evaluateGridStability(onsets, 0.5, 0.2, 30);
    expect(result.supportedWindowFraction).toBe(1);
    expect(result.phaseSpreadMs).toBeCloseTo(0, 8);
    for (const window of result.windows) {
      expect(window.matchedBeatCount).toBe(20);
      expect(window.expectedBeatCount).toBe(20);
      expect(window.coverage).toBe(1);
      expect(window.residualMs).toBeCloseTo(20, 8);
      expect(Math.abs(window.driftMsPerSecond!)).toBeLessThan(0.1);
    }
    expect(result.maxAbsDriftMsPerSecond).toBeLessThan(0.1);
    const early = evaluateGridStability(
      beats(10).map((time) => time - 0.02),
      0.6,
      0.2,
      10,
    );
    expect(early.windows[0]!.residualMs).toBeCloseTo(-20);
    expect(early.windows[0]!.driftMsPerSecond).toBeCloseTo(0);
  });

  it("detects the signed slope from a slightly wrong period", () => {
    const result = evaluateGridStability(beats(30), 0.601, 0.2, 30);
    expect(result.supportedWindowFraction).toBe(1);
    for (const window of result.windows) {
      expect(window.driftMsPerSecond).toBeCloseTo((-1000 * 0.001) / 0.601, 8);
    }
    expect(result.maxAbsDriftMsPerSecond).toBeCloseTo((1000 * 0.001) / 0.601, 8);
    expect(result.phaseSpreadMs).toBeGreaterThan(30);
  });

  it("keeps a missing middle segment in the support denominator", () => {
    const onsets = beats(30).filter((time) => time < 10 || time >= 20);
    const result = evaluateGridStability(onsets, 0.6, 0.2, 30);
    expect(result.supportedWindowFraction).toBe(2 / 3);
    expect(result.windows[1]).toMatchObject({
      onsetCount: 0,
      matchedBeatCount: 0,
      coverage: 0,
      residualMs: null,
      driftMsPerSecond: null,
    });
    expect(result.windows[1]!.expectedBeatCount).toBeGreaterThan(0);
    expect(result.maxAbsDriftMsPerSecond).toBeCloseTo(0);
    expect(result.phaseSpreadMs).toBeCloseTo(0);
  });

  it("reveals a tempo change with local regression rather than a global average", () => {
    const onsets = [...beats(10), ...beats(10, 0.603).map((time) => time + 10.2)];
    const result = evaluateGridStability(onsets, 0.6, 0.2, 20);
    expect(result.supportedWindowFraction).toBe(1);
    expect(result.windows[0]!.driftMsPerSecond).toBeCloseTo(0);
    expect(result.windows[1]!.driftMsPerSecond).toBeCloseTo(5, 8);
    expect(result.maxAbsDriftMsPerSecond).toBeCloseTo(5, 8);
    expect(result.phaseSpreadMs).toBeGreaterThan(20);
  });

  it("counts each beat once and chooses the closest residual vote", () => {
    const original = beats(10, 0.5).map((time) => time + 0.01);
    const duplicated = original.flatMap((time) => [time + 0.02, time, time, time - 0.04]);
    const result = evaluateGridStability(duplicated, 0.5, 0.2, 10);
    const reference = evaluateGridStability(original, 0.5, 0.2, 10);
    expect(result.windows[0]).toEqual({ ...reference.windows[0], onsetCount: duplicated.length });
    expect(result.windows[0]!.coverage).toBe(1);
    const insufficient = evaluateGridStability(Array(100).fill(0.2), 0.5, 0.2, 10);
    expect(insufficient.windows[0]!.matchedBeatCount).toBe(1);
    expect(insufficient.supportedWindowFraction).toBe(0);
  });

  it("requires both four distinct beats and at least twenty percent coverage", () => {
    const tooSparse = evaluateGridStability([0, 0.1, 0.2, 0.3], 0.1, 0, 10);
    expect(tooSparse.windows[0]!.matchedBeatCount).toBe(4);
    expect(tooSparse.windows[0]!.coverage).toBe(0.04);
    expect(tooSparse.windows[0]!.residualMs).toBeNull();
    expect(tooSparse.windows[0]!.driftMsPerSecond).toBeNull();
    expect(tooSparse.supportedWindowFraction).toBe(0);
    expect(evaluateGridStability([0, 0.5, 1, 1.5], 0.5, 0, 10).supportedWindowFraction).toBe(1);
    expect(evaluateGridStability([0, 1, 2], 1, 0, 4).supportedWindowFraction).toBe(0);
  });

  it("uses exact half-open boundaries and includes even a very short trailing window", () => {
    const result = evaluateGridStability([0, 5, 10, 15, 20, 20.001], 5, 0, 20.001);
    expect(result.windows.map((window) => [window.startMs, window.endMs])).toEqual([
      [0, 10000],
      [10000, 20000],
      [20000, 20001],
    ]);
    expect(result.windows.map((window) => window.expectedBeatCount)).toEqual([2, 2, 1]);
    expect(result.windows.map((window) => window.onsetCount)).toEqual([2, 2, 1]);
    expect(result.windows.map((window) => window.matchedBeatCount)).toEqual([2, 2, 1]);
    expect(evaluateGridStability([], 5, 0, 20).windows).toHaveLength(2);
    expect(evaluateGridStability([], 0.1, 0.3, 10).windows[0]!.expectedBeatCount).toBe(97);
  });

  it("excludes grid beats outside the onset's window, negative indices and negative times", () => {
    const boundary = evaluateGridStability([9.99, 10.01], 0.5, 0, 20);
    expect(boundary.windows.map((window) => window.matchedBeatCount)).toEqual([0, 1]);
    const futurePhase = evaluateGridStability([0, 1, 2, 3, 4], 1, 2, 5);
    expect(futurePhase.windows[0]!.expectedBeatCount).toBe(3);
    expect(futurePhase.windows[0]!.matchedBeatCount).toBe(3);
    const pastPhase = evaluateGridStability([0, 1, 2, 3], 1, -2, 4);
    expect(pastPhase.windows[0]!.expectedBeatCount).toBe(4);
    expect(pastPhase.windows[0]!.matchedBeatCount).toBe(4);
    const negativeBeat = evaluateGridStability([0], 1, -0.01, 1);
    expect(negativeBeat.windows[0]!.matchedBeatCount).toBe(0);
  });

  it("accepts the inclusive tolerance but rejects outliers", () => {
    const result = evaluateGridStability([0.3, 1.1, 2.30001, 3.31], 1, 0.2, 5);
    expect(result.windows[0]!.onsetCount).toBe(4);
    expect(result.windows[0]!.matchedBeatCount).toBe(2);
  });

  it("filters invalid and out-of-range onsets, sorts a copy and does not mutate input", () => {
    const input = [3.2, NaN, -1, 0.2, Infinity, 2.2, -Infinity, 1.2, 4, 5];
    const before = input.slice();
    const result = evaluateGridStability(input, 1, 0.2, 4);
    expect(input).toEqual(before);
    expect(result.windows[0]!.onsetCount).toBe(4);
    expect(result.windows[0]!.matchedBeatCount).toBe(4);
    expect(result.supportedWindowFraction).toBe(1);
  });

  it("does not fabricate drift or phase evidence when no windows are supported", () => {
    for (const onsets of [[], [0.123, 2.345]]) {
      const result = evaluateGridStability(onsets, 1, 0, 21);
      expect(result.windows).toHaveLength(3);
      expect(result.supportedWindowFraction).toBe(0);
      expect(result.maxAbsDriftMsPerSecond).toBeNull();
      expect(result.phaseSpreadMs).toBeNull();
      for (const window of result.windows) {
        expect(window.residualMs).toBeNull();
        expect(window.driftMsPerSecond).toBeNull();
      }
    }
    const noBeats = evaluateGridStability([1], 1, 20, 5);
    expect(noBeats.windows[0]!.expectedBeatCount).toBe(0);
    expect(noBeats.windows[0]!.coverage).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])("rejects invalid period or duration %s", (value) => {
    expect(() => evaluateGridStability([], value, 0, 10)).toThrow(RangeError);
    expect(() => evaluateGridStability([], 1, 0, value)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite phase %s", (value) => {
    expect(() => evaluateGridStability([], 1, value, 10)).toThrow(RangeError);
  });
});
