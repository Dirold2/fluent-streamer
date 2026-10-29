import { describe, expect, it } from "vitest";
import { findStableSections } from "../src/Audio/analysis/StableSections.js";

function beats(duration: number, period = 0.5, phase = 0.2): number[] {
  return Array.from(
    { length: Math.max(0, Math.ceil((duration - phase) / period)) },
    (_, index) => phase + index * period,
  ).filter((time) => time < duration);
}

describe("findStableSections", () => {
  it("returns only full training/holdout pairs with strong regular support", () => {
    const sections = findStableSections(beats(55), 0.501, 55);
    expect(
      sections.map((section) => [
        section.startMs,
        section.endMs,
        section.validationStartMs,
        section.validationEndMs,
      ]),
    ).toEqual([
      [0, 20000, 20000, 30000],
      [10000, 30000, 30000, 40000],
      [20000, 40000, 40000, 50000],
    ]);
    for (const section of sections) {
      expect(section.bpm).toBeCloseTo(120, 8);
      expect(section.beatPhaseMs).toBeCloseTo(200, 8);
      expect(section.trainingCoverage).toBe(1);
      expect(section.validationCoverage).toBe(1);
      expect(section.trainingMatchedBeats).toBe(40);
      expect(section.validationMatchedBeats).toBe(20);
      expect(section.trainingErrorMs).toBeLessThan(1e-8);
      expect(section.validationErrorMs).toBeLessThan(1e-8);
      expect(section.phaseShiftMs).toBeCloseTo(0, 8);
    }
  });

  it("selects later sections when the first twenty seconds have no onsets", () => {
    const sections = findStableSections(
      beats(60).filter((time) => time >= 20),
      0.5,
      60,
    );
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((section) => section.startMs >= 10000)).toBe(true);
    expect(sections.some((section) => section.startMs === 20000)).toBe(true);
    // Half-supported training still qualifies at the specified inclusive limit.
    expect(sections[0]!.trainingCoverage).toBe(0.5);
    expect(sections[0]!.trainingMatchedBeats).toBe(20);
  });

  it("rejects missing or incomplete holdout even with perfect training", () => {
    expect(findStableSections(beats(20), 0.5, 30)).toEqual([]);
    expect(findStableSections(beats(29.999), 0.5, 29.999)).toEqual([]);
    expect(findStableSections(beats(30), 0.5, 30)).toHaveLength(1);
  });

  it("rejects a changed holdout tempo without refitting to it", () => {
    const onsets = [...beats(20), ...beats(10, 0.53).map((time) => time + 20)];
    expect(findStableSections(onsets, 0.5, 30)).toEqual([]);
  });

  it("keeps fitted training parameters unchanged when holdout attacks change", () => {
    const onsets = beats(30);
    const reference = findStableSections(onsets, 0.502, 30)[0]!;
    for (const offset of [-0.01, 0.01]) {
      const section = findStableSections(
        onsets.map((time) => (time < 20 ? time : time + offset)),
        0.502,
        30,
      )[0]!;
      expect(section).toBeDefined();
      expect(section.bpm).toBe(reference.bpm);
      expect(section.beatPhaseMs).toBe(reference.beatPhaseMs);
      expect(section.trainingErrorMs).toBe(reference.trainingErrorMs);
      expect(section.trainingCoverage).toBe(reference.trainingCoverage);
      expect(section.phaseShiftMs).toBeCloseTo(offset * 1000, 8);
      expect(section.validationErrorMs).toBeCloseTo(Math.abs(offset) * 1000, 8);
    }
  });

  it("does not let duplicate attacks inflate fitting or matched coverage", () => {
    const onsets = beats(30);
    expect(
      findStableSections(
        onsets.flatMap((time) => Array(12).fill(time)),
        0.5,
        30,
      ),
    ).toEqual(findStableSections(onsets, 0.5, 30));
    const sparse = onsets.filter((time) => time < 5 || (time >= 20 && time < 23));
    expect(
      findStableSections(
        sparse.flatMap((time) => Array(50).fill(time)),
        0.5,
        30,
      ),
    ).toEqual([]);
    const clustered = onsets.flatMap((time) => [time - 0.005, time, time + 0.005]);
    const section = findStableSections(clustered, 0.5, 30)[0]!;
    expect(section.trainingMatchedBeats).toBe(40);
    expect(section.validationMatchedBeats).toBe(20);
    expect(section.trainingCoverage).toBe(1);
    expect(section.validationCoverage).toBe(1);
  });

  it("accepts predictable balanced jitter and reports nonzero RMS", () => {
    const onsets = beats(40).map((time, index) => time + (index % 2 ? 0.008 : -0.008));
    const sections = findStableSections(onsets, 0.5, 40);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.trainingCoverage).toBe(1);
      expect(section.validationCoverage).toBe(1);
      expect(section.trainingErrorMs).toBeGreaterThan(7);
      expect(section.validationErrorMs).toBeGreaterThan(7);
      expect(section.validationErrorMs).toBeLessThan(10);
      expect(Math.abs(section.phaseShiftMs)).toBeLessThan(2);
    }
  });

  it("handles noninteger tempo and normalizes absolute phase in later windows", () => {
    const period = 60 / 127.3;
    const phase = 0.137;
    const sections = findStableSections(beats(60, period, phase), period * 1.02, 60);
    expect(sections).toHaveLength(4);
    for (const section of sections) {
      expect(section.bpm).toBeCloseTo(127.3, 8);
      expect(section.beatPhaseMs).toBeCloseTo(137, 8);
      expect(section.beatPhaseMs).toBeGreaterThanOrEqual(0);
      expect(section.beatPhaseMs).toBeLessThan(60000 / section.bpm);
      expect(section.trainingCoverage).toBe(1);
      expect(section.validationCoverage).toBe(1);
    }
  });

  it("counts half-open boundaries once and supports zero phase", () => {
    const section = findStableSections(beats(30, 0.5, 0), 0.5, 30)[0]!;
    expect(section).toBeDefined();
    expect(section.beatPhaseMs).toBeCloseTo(0, 8);
    expect(section.trainingMatchedBeats).toBe(40);
    expect(section.validationMatchedBeats).toBe(20);
    expect(section.trainingCoverage).toBe(1);
    expect(section.validationCoverage).toBe(1);
  });

  it("requires coverage as well as distinct matched beat counts", () => {
    const sparseTraining = beats(30, 0.25).filter((time, index) => time >= 20 || index % 3 === 0);
    expect(findStableSections(sparseTraining, 0.25, 30)).toEqual([]);
    const sparseHoldout = beats(30, 0.25).filter((time, index) => time < 20 || index % 3 === 0);
    expect(findStableSections(sparseHoldout, 0.25, 30)).toEqual([]);
    // A slow grid can have full coverage but too few distinct training beats.
    expect(findStableSections(beats(30, 1.1), 1.1, 30)).toEqual([]);
    const sevenHoldout = [
      ...beats(20),
      ...beats(10)
        .slice(0, 7)
        .map((time) => time + 20),
    ];
    expect(findStableSections(sevenHoldout, 0.5, 30)).toEqual([]);
  });

  it("rejects excessive holdout residuals even when attacks match the grid", () => {
    for (const offset of [-0.035, 0.035]) {
      const onsets = beats(30).map((time) => (time < 20 ? time : time + offset));
      expect(findStableSections(onsets, 0.5, 30)).toEqual([]);
    }
  });

  it("filters invalid onsets, sorts deterministically and does not mutate input", () => {
    const regular = beats(40);
    const input = Object.freeze(
      [...regular].reverse().concat([NaN, Infinity, -Infinity, -1, 40, 100]),
    );
    const expected = findStableSections(regular, 0.5, 40);
    const snapshot = [...input];
    expect(findStableSections(input as number[], 0.5, 40)).toEqual(expected);
    expect(findStableSections(input as number[], 0.5, 40)).toEqual(expected);
    expect(input).toEqual(snapshot);
    expect(findStableSections([], 0.5, 40)).toEqual([]);
    expect(findStableSections([NaN, -1, Infinity], 0.5, 40)).toEqual([]);
    expect(findStableSections(regular, 0.5, 0)).toEqual([]);
  });

  it("throws for invalid periods and durations, including with empty onsets", () => {
    for (const period of [0, -0.5, NaN, Infinity, -Infinity]) {
      expect(() => findStableSections([], period, 30)).toThrow(RangeError);
    }
    for (const duration of [-1, NaN, Infinity, -Infinity]) {
      expect(() => findStableSections([], 0.5, duration)).toThrow(RangeError);
    }
  });
});
