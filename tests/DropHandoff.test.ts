import { describe, expect, it } from "vitest";
import { planDropHandoff, type DropHandoffOptions } from "../src/Audio/analysis/AutomixPlan.js";
import type { DjAnalysis } from "../src/Audio/analysis/DjAnalysis.js";

function analysis(dropMs: number | null): DjAnalysis {
  return {
    bpm: 120,
    bpmConfidence: 0.9,
    beatPhaseMs: 0,
    beatPhaseConfidence: 0.9,
    dropMs,
    dropConfidence: 0.9,
    analyzedDurationMs: 90000,
  };
}
const options: DropHandoffOptions = {
  outgoingLateAnalysis: analysis(30000),
  incomingAnalysis: analysis(20000),
  windowStartMs: 100000,
  outgoingDurationMs: 200000,
  outgoingPositionMs: 95000,
  incomingDurationMs: 160000,
};

describe("planDropHandoff", () => {
  it("aligns a measured rise in the outgoing second half with the incoming first-half rise", () => {
    const plan = planDropHandoff(options)!;
    expect(plan).toEqual({
      startMs: 114000,
      cueMs: 4000,
      seconds: 16,
      dropMs: 20000,
      beatPeriodMs: 500,
      reason: "drop-handoff",
    });
    expect(plan.startMs + plan.seconds * 1000).toBe(130000);
    expect(plan.cueMs + plan.seconds * 1000).toBe(20000);
  });

  it("uses the first confident rise in each half, not the loudest later rise", () => {
    const plan = planDropHandoff({
      ...options,
      outgoingLateAnalysis: {
        ...analysis(30000),
        dropCandidates: [
          { ms: 25000, confidence: 0.8 },
          { ms: 30000, confidence: 1 },
        ],
      },
      incomingAnalysis: {
        ...analysis(20000),
        dropCandidates: [
          { ms: 8000, confidence: 0.8 },
          { ms: 20000, confidence: 1 },
        ],
      },
    })!;
    expect(plan).toMatchObject({ startMs: 117000, cueMs: 0, dropMs: 8000 });
    expect(plan.seconds).toBe(8);
    const nextUsable = planDropHandoff({
      ...options,
      outgoingPositionMs: 123000,
      outgoingLateAnalysis: {
        ...analysis(30000),
        dropCandidates: [
          { ms: 25000, confidence: 0.8 },
          { ms: 30000, confidence: 1 },
        ],
      },
    });
    expect(nextUsable).toMatchObject({ startMs: 124000, seconds: 6, dropMs: 20000 });
    expect(
      planDropHandoff({
        ...options,
        incomingAnalysis: {
          ...analysis(20000),
          dropCandidates: [
            { ms: 8000, confidence: 0.6 },
            { ms: 90000, confidence: 1 },
          ],
        },
      }),
    ).toBeNull();
  });

  it("maps the incoming cue through a tempo adjustment during the overlap", () => {
    const plan = planDropHandoff({
      ...options,
      incomingAnalysis: { ...analysis(20000), bpm: 125, beatPhaseMs: 320 },
      enableTempoMatch: true,
    })!;
    expect(plan.cueMs + plan.seconds * 1000 * (120 / 125)).toBeCloseTo(20000);
    expect(
      planDropHandoff({ ...options, incomingAnalysis: { ...analysis(20000), bpm: 125 } }),
    ).toBeNull();
    expect(
      planDropHandoff({
        ...options,
        incomingAnalysis: { ...analysis(20000), bpm: 150 },
        enableTempoMatch: true,
      }),
    ).toBeNull();
  });

  it("abstains instead of inventing a drop or mixing after it passed", () => {
    expect(planDropHandoff({ ...options, outgoingLateAnalysis: analysis(null) })).toBeNull();
    expect(planDropHandoff({ ...options, incomingAnalysis: analysis(null) })).toBeNull();
    expect(
      planDropHandoff({
        ...options,
        outgoingLateAnalysis: { ...analysis(30000), dropConfidence: 0.69 },
      }),
    ).toBeNull();
    expect(
      planDropHandoff({
        ...options,
        incomingAnalysis: { ...analysis(20000), beatPhaseConfidence: 0.1 },
      }),
    ).toBeNull();
    expect(planDropHandoff({ ...options, outgoingLateAnalysis: analysis(90000) })).toBeNull();
    expect(planDropHandoff({ ...options, incomingAnalysis: analysis(85000) })).toBeNull();
    expect(planDropHandoff({ ...options, outgoingPositionMs: 129000 })).toBeNull();
    expect(planDropHandoff({ ...options, windowStartMs: 99000 })).toBeNull();
    expect(planDropHandoff({ ...options, incomingDurationMs: 30000 })).toBeNull();
    expect(
      planDropHandoff({ ...options, incomingAnalysis: { ...analysis(20000), beatPhaseMs: 137 } }),
    ).toBeNull();
  });
});
