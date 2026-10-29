import { describe, expect, it } from "vitest";
import type { StableSection } from "../src/Audio/analysis/DjAnalysisCore.js";
import { planSectionTransition } from "../src/Audio/analysis/SectionTransitionPlan.js";

function section(overrides: Partial<StableSection> = {}): StableSection {
  return {
    startMs: 0,
    endMs: 20000,
    validationStartMs: 20000,
    validationEndMs: 30000,
    bpm: 120,
    beatPhaseMs: 100,
    trainingCoverage: 1,
    validationCoverage: 1,
    trainingMatchedBeats: 40,
    validationMatchedBeats: 20,
    trainingErrorMs: 0,
    validationErrorMs: 0,
    phaseShiftMs: 0,
    ...overrides,
  };
}

function plan(
  outgoing = section(),
  incoming = section(),
  outgoingPositionMs = 0,
  limits: { maxOverlapMs?: number; minOverlapBeats?: number } = {},
) {
  return planSectionTransition({
    outgoingSections: [outgoing],
    incomingSections: [incoming],
    outgoingPositionMs,
    ...limits,
  });
}

describe("planSectionTransition", () => {
  it("quantizes equal-tempo starts, maximizes overlap and prefers the latest outgoing start", () => {
    const result = plan(section(), section(), 20555)!;
    expect(result).toEqual({
      outgoingStartMs: 21600,
      incomingCueMs: 20100,
      overlapMs: 8000,
      outgoingBpm: 120,
      incomingBpm: 120,
      estimatedErrorMs: 0,
      driftMsPerSecond: 0,
      outgoingSectionIndex: 0,
      incomingSectionIndex: 0,
      previewOnly: true,
    });
    expect(Number.isInteger((result.outgoingStartMs - 100) / 500)).toBe(true);
    expect(Number.isInteger((result.incomingCueMs - 100) / 500)).toBe(true);
    expect(result.outgoingStartMs).toBeGreaterThanOrEqual(20555);
    expect(result.outgoingStartMs + result.overlapMs).toBeLessThanOrEqual(30000);
    expect(result.incomingCueMs + result.overlapMs).toBeLessThanOrEqual(30000);
  });

  it("shortens unequal-tempo overlap to integral outgoing beats within the heuristic budget", () => {
    const result = plan(section(), section({ bpm: 121 }))!;
    expect(result.overlapMs).toBe(3500);
    expect(result.driftMsPerSecond).toBeCloseTo(1000 / 120);
    expect(result.estimatedErrorMs).toBeCloseTo(3500 / 120);
    const budget = 60000 / 121 / 16;
    expect(result.estimatedErrorMs).toBeLessThanOrEqual(budget);
    expect(result.estimatedErrorMs + 500 / 120).toBeGreaterThan(budget);
    expect(plan(section(), section({ bpm: 121 }), 0, { minOverlapBeats: 8 })).toBeNull();
  });

  it("permits arbitrary ratios only when at least one beat fits the drift budget", () => {
    expect(
      plan(
        section({ bpm: 100, validationErrorMs: 5 }),
        section({ bpm: 110, validationErrorMs: 5 }),
      ),
    ).toBeNull();
    // Even with zero baseline error, 60 ms drift exceeds the ~34.09 ms budget.
    expect(600 * Math.abs(600 / (60000 / 110) - 1)).toBeGreaterThan(60000 / 110 / 16);
    expect(plan(section({ bpm: 100 }), section({ bpm: 110 }))).toBeNull();
    expect(plan(section({ bpm: 100 }), section({ bpm: 105 }))!.overlapMs).toBe(600);
  });

  it("uses both holdout capacities, never training ranges", () => {
    expect(plan(section(), section(), 29900)).toBeNull();
    expect(plan(section(), section(), 40000)).toBeNull();
    expect(plan(section(), section({ validationEndMs: 21100 }))!.overlapMs).toBe(1000);
    expect(plan(section({ validationEndMs: 21100 }))!.overlapMs).toBe(1000);
    expect(plan(section(), section(), 29500)).toBeNull();
    expect(plan(section(), section(), 29100)!.overlapMs).toBe(500);
    expect(plan(section(), section(), 0, { maxOverlapMs: 499 })).toBeNull();
    expect(plan(section(), section(), 0, { maxOverlapMs: 1750 })!.overlapMs).toBe(1500);
  });

  it("includes validation errors and absolute phase shifts without correcting the grid", () => {
    const result = plan(
      section({ validationErrorMs: 5, phaseShiftMs: -10 }),
      section({ validationErrorMs: 6, phaseShiftMs: 10 }),
    )!;
    expect(result.estimatedErrorMs).toBe(31);
    expect(result.incomingCueMs).toBe(20100);
    expect(result.outgoingStartMs).toBe(21600);
    expect(
      plan(
        section({ validationErrorMs: 20, phaseShiftMs: -20 }),
        section({ validationErrorMs: 20, phaseShiftMs: 20 }),
      ),
    ).toBeNull();
    // Equal-tempo baseline exactly at the production budget remains feasible.
    const budget = 500 / 16;
    expect(
      plan(
        section({ validationErrorMs: 12.5, phaseShiftMs: 12.5 }),
        section({ validationErrorMs: 6.25 }),
      )!.estimatedErrorMs,
    ).toBe(budget);
    expect(
      plan(
        section({ validationErrorMs: 12.5, phaseShiftMs: 12.5 }),
        section({ validationErrorMs: 6.250001 }),
      ),
    ).toBeNull();
    expect(
      plan(
        section({ validationErrorMs: 5, phaseShiftMs: -10 }),
        section({ validationErrorMs: 6, phaseShiftMs: 12 }),
      ),
    ).toBeNull();
  });

  it("rejects invalid scalar options even for empty section arrays", () => {
    const empty = { outgoingSections: [], incomingSections: [], outgoingPositionMs: 0 };
    for (const outgoingPositionMs of [NaN, Infinity, -Infinity, -1]) {
      expect(() => planSectionTransition({ ...empty, outgoingPositionMs })).toThrow(RangeError);
    }
    for (const maxOverlapMs of [NaN, Infinity, -Infinity, 0, -1, 16001]) {
      expect(() => planSectionTransition({ ...empty, maxOverlapMs })).toThrow(RangeError);
    }
    for (const minOverlapBeats of [NaN, Infinity, -Infinity, 0, -1, 1.5]) {
      expect(() => planSectionTransition({ ...empty, minOverlapBeats })).toThrow(RangeError);
    }
    expect(planSectionTransition(empty)).toBeNull();
    expect(
      plan(section({ validationEndMs: 50000 }), section({ validationEndMs: 50000 }), 0, {
        maxOverlapMs: 16000,
      })!.overlapMs,
    ).toBe(16000);
  });

  const malformed: Partial<StableSection>[] = [
    { bpm: 69 },
    { bpm: 181 },
    { beatPhaseMs: -1 },
    { beatPhaseMs: 500 },
    { startMs: -1 },
    { startMs: 20000 },
    { endMs: 20001 },
    { validationEndMs: 20000 },
    { trainingCoverage: 0.49 },
    { trainingCoverage: 1.01 },
    { validationCoverage: 0.49 },
    { validationCoverage: 1.01 },
    { trainingMatchedBeats: 19 },
    { trainingMatchedBeats: 20.5 },
    { validationMatchedBeats: 7 },
    { validationMatchedBeats: 8.5 },
    { trainingErrorMs: -1 },
    { trainingErrorMs: 25.01 },
    { validationErrorMs: -1 },
    { validationErrorMs: 25.01 },
    { phaseShiftMs: 25.01 },
    { phaseShiftMs: -25.01 },
  ];
  it.each(malformed)("ignores malformed sections: %j", (invalid) => {
    const bad = section(invalid);
    expect(plan(bad)).toBeNull();
    expect(plan(section(), bad)).toBeNull();
    expect(
      planSectionTransition({
        outgoingSections: [bad, section()],
        incomingSections: [bad, section()],
        outgoingPositionMs: 0,
      })!.outgoingSectionIndex,
    ).toBe(1);
  });

  it("ignores all nonfinite fields on either side", () => {
    for (const field of Object.keys(section()) as (keyof StableSection)[]) {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(plan(section({ [field]: value }))).toBeNull();
        expect(plan(section(), section({ [field]: value }))).toBeNull();
      }
    }
  });

  it("accepts inclusive quality limits and does not require exact training/holdout durations", () => {
    expect(
      plan(
        section({
          startMs: 1,
          trainingCoverage: 0.5,
          validationCoverage: 0.5,
          trainingMatchedBeats: 20,
          validationMatchedBeats: 8,
          trainingErrorMs: 25,
          validationEndMs: 29000,
        }),
      ),
    ).not.toBeNull();
    for (const bpm of [70, 180]) expect(plan(section({ bpm }), section({ bpm }))).not.toBeNull();
  });

  it("prefers longer overlap over lower error, then lower error over later start", () => {
    const longer = section({ validationErrorMs: 10 });
    const shorter = section({ validationEndMs: 25000 });
    const result = planSectionTransition({
      outgoingSections: [shorter, longer],
      incomingSections: [section()],
      outgoingPositionMs: 0,
    })!;
    expect(result.outgoingSectionIndex).toBe(1);
    const cleaner = section({ validationEndMs: 29000 });
    expect(
      planSectionTransition({
        outgoingSections: [longer, cleaner],
        incomingSections: [section()],
        outgoingPositionMs: 0,
      })!.outgoingSectionIndex,
    ).toBe(1);
  });

  it("prefers later outgoing, then earlier incoming, independent of input order; never mutates", () => {
    const outgoing = [section(), section({ validationEndMs: 31000 })].map((value) =>
      Object.freeze(value),
    );
    const incoming = [
      section({ startMs: 1000, endMs: 21000, validationStartMs: 21000, validationEndMs: 31000 }),
      section(),
    ].map((value) => Object.freeze(value));
    const run = (out: readonly StableSection[], inc: readonly StableSection[]) =>
      planSectionTransition({
        outgoingSections: out,
        incomingSections: inc,
        outgoingPositionMs: 0,
      })!;
    const original = run(Object.freeze(outgoing), Object.freeze(incoming));
    const reordered = run([...outgoing].reverse(), [...incoming].reverse());
    expect(original.outgoingSectionIndex).toBe(1);
    expect(original.incomingSectionIndex).toBe(1);
    expect(reordered).toEqual({ ...original, outgoingSectionIndex: 0, incomingSectionIndex: 0 });
    expect(run(outgoing, incoming)).toEqual(original);
  });

  it("resolves exact ranking ties semantically, not by array order", () => {
    const a = section({ trainingCoverage: 0.75 });
    const b = section({ trainingCoverage: 1 });
    const run = (outgoingSections: StableSection[]) =>
      planSectionTransition({
        outgoingSections,
        incomingSections: [section()],
        outgoingPositionMs: 0,
      })!;
    expect(run([a, b]).outgoingSectionIndex).toBe(0);
    expect(run([b, a]).outgoingSectionIndex).toBe(1);
  });
});
