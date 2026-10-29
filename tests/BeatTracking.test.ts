import { describe, expect, it } from "vitest";
import { trackBeatSequence } from "../src/Audio/analysis/BeatTracking.js";

function impulses(length: number, positions: number[], amplitude = 1): Float64Array {
  const envelope = new Float64Array(length);
  for (const position of positions) envelope[position] = amplitude;
  return envelope;
}

function expectTimes(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((time, index) => expect(time).toBeCloseTo(expected[index]!, 8));
}

const empty = { beatTimesMs: [], observedBeatFraction: 0, intervalErrorMs: null };

describe("trackBeatSequence", () => {
  const positions = Array.from({ length: 12 }, (_, index) => 20 + index * 50);
  const expectedTimes = positions.map((frame) => frame * 10);

  it("tracks regular impulses without extending the sequence into silence", () => {
    const result = trackBeatSequence(impulses(650, positions), 0.01, 0.5);
    expectTimes(result.beatTimesMs, expectedTimes);
    expect(result.observedBeatFraction).toBe(1);
    expect(result.intervalErrorMs).toBe(0);
  });

  it("prefers the sustained strong beat phase over quiet offbeat distractors", () => {
    const envelope = impulses(650, positions);
    for (const position of positions) envelope[position + 25] = 0.15;
    expectTimes(trackBeatSequence(envelope, 0.01, 0.5).beatTimesMs, expectedTimes);
  });

  it("bridges isolated missing beats and reports their lack of local support", () => {
    const envelope = impulses(
      650,
      positions.filter((_, index) => index !== 4 && index !== 8),
    );
    const result = trackBeatSequence(envelope, 0.01, 0.5);
    expectTimes(result.beatTimesMs, expectedTimes);
    expect(result.observedBeatFraction).toBeCloseTo(10 / 12);
    expect(result.intervalErrorMs).toBe(0);
  });

  it("trims weak leading and trailing beats without trimming weak interior beats", () => {
    const envelope = impulses(
      750,
      positions.map((position) => position + 50),
    );
    envelope[20] = 0.01;
    envelope[670] = 0.01;
    envelope[270] = 0.01;
    const result = trackBeatSequence(envelope, 0.01, 0.5);
    expectTimes(
      result.beatTimesMs,
      expectedTimes.map((time) => time + 500),
    );
    expect(result.observedBeatFraction).toBe(1);
  });

  it("applies positive and negative offsets only to positions, not metrics", () => {
    const envelope = impulses(650, positions);
    const original = trackBeatSequence(envelope, 0.01, 0.5);
    for (const offset of [1.25, -0.75]) {
      const result = trackBeatSequence(envelope, 0.01, 0.5, offset);
      result.beatTimesMs.forEach((time, index) => {
        expect(time).toBeCloseTo(original.beatTimesMs[index]! + offset * 1000);
      });
      expect(result.observedBeatFraction).toBe(original.observedBeatFraction);
      expect(result.intervalErrorMs).toBe(original.intervalErrorMs);
    }
  });

  it.each([0.4, 0.5, 0.6, 0.503])("keeps intervals near a supplied %s second period", (period) => {
    const frames = Array.from({ length: 20 }, (_, index) =>
      Math.round(20 + (index * period) / 0.01),
    );
    const result = trackBeatSequence(impulses(frames[19]! + 80, frames), 0.01, period);
    expect(result.beatTimesMs).toHaveLength(frames.length);
    result.beatTimesMs.forEach((time, index) => expect(time).toBeCloseTo(frames[index]! * 10));
    const errors = result.beatTimesMs
      .slice(1)
      .map((time, index) => Math.abs(time - result.beatTimesMs[index]! - period * 1000));
    expect(Math.max(...errors)).toBeLessThanOrEqual(10);
    expect(result.intervalErrorMs).toBeCloseTo(
      errors.reduce((sum, error) => sum + error, 0) / errors.length,
    );
  });

  it("accepts the two-frame minimum period", () => {
    const result = trackBeatSequence(impulses(12, [1, 3, 5, 7, 9]), 0.01, 0.02);
    expect(result.beatTimesMs).toEqual([10, 30, 50, 70, 90]);
    expect(result.intervalErrorMs).toBe(0);
  });

  it("returns one supported event without inventing a measurable interval", () => {
    expect(trackBeatSequence(impulses(200, [75]), 0.01, 0.5)).toEqual({
      beatTimesMs: [750],
      observedBeatFraction: 1,
      intervalErrorMs: null,
    });
  });

  it.each([[], new Float64Array(200), [NaN, Infinity, -Infinity, -1, 0], [1e-13, 1e-12]])(
    "returns an empty result for empty, silent, invalid-only, or negligible input %#",
    (envelope) => expect(trackBeatSequence(envelope, 0.01, 0.5)).toEqual(empty),
  );

  it("ignores invalid samples, normalizes gain, accepts ArrayLike, and does not mutate input", () => {
    const envelope = Array.from(impulses(650, positions, 1e100));
    envelope[1] = NaN;
    envelope[2] = Infinity;
    envelope[3] = -1;
    const before = envelope.slice();
    const result = trackBeatSequence(envelope, 0.01, 0.5);
    expectTimes(result.beatTimesMs, expectedTimes);
    expect(envelope).toEqual(before);
    expect(trackBeatSequence({ 0: 1, length: 1 }, 0.01, 0.5)).toEqual({
      beatTimesMs: [0],
      observedBeatFraction: 1,
      intervalErrorMs: null,
    });
  });

  it("is deterministic on bounded noise, without treating support as confidence", () => {
    let seed = 42;
    const envelope = Float64Array.from({ length: 4500 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    const result = trackBeatSequence(envelope, 0.02, 0.5);
    expect(trackBeatSequence(envelope, 0.02, 0.5)).toEqual(result);
    expect(result.beatTimesMs.length).toBeGreaterThan(1);
    expect(result.observedBeatFraction).toBe(1);
    expect(Number.isFinite(result.intervalErrorMs)).toBe(true);
    result.beatTimesMs.forEach((time, index) => {
      expect(Number.isFinite(time)).toBe(true);
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThan(90000);
      if (index > 0) {
        const gap = time - result.beatTimesMs[index - 1]!;
        expect(gap).toBeGreaterThanOrEqual(250 - 1e-8);
        expect(gap).toBeLessThanOrEqual(750 + 1e-8);
      }
    });
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid frame duration %s", (frame) => {
    expect(() => trackBeatSequence([], frame, 0.5)).toThrow(RangeError);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, 0.019])("rejects invalid period %s", (period) => {
    expect(() => trackBeatSequence([], 0.01, period)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite offset %s", (offset) => {
    expect(() => trackBeatSequence([], 0.01, 0.5, offset)).toThrow(RangeError);
  });
});
