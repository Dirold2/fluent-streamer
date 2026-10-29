import { describe, expect, it } from "vitest";
import {
  planAutomix,
  type AutomixDiagnostic,
  type AutomixFallbackReason,
  type AutomixPlanOptions,
} from "../src/Audio/analysis/AutomixPlan.js";
import type { DjAnalysis } from "../src/Audio/analysis/DjAnalysis.js";

function analysis(overrides: Partial<DjAnalysis> = {}): DjAnalysis {
  return {
    bpm: 120,
    bpmConfidence: 0.8,
    beatPhaseMs: 137,
    beatPhaseConfidence: 0.8,
    dropMs: null,
    dropConfidence: 0,
    analyzedDurationMs: 90000,
    ...overrides,
  };
}

function options(overrides: Partial<AutomixPlanOptions> = {}): AutomixPlanOptions {
  return {
    outgoingAnalysis: analysis(),
    incomingAnalysis: analysis(),
    outgoingPositionMs: 10137,
    outgoingRemainingMs: 30000,
    fallbackSeconds: 5,
    ...overrides,
  };
}

function expectFallback(input: AutomixPlanOptions): void {
  expect(planAutomix(input)).toEqual({
    seconds: Math.min(input.fallbackSeconds, 16, (input.outgoingRemainingMs - 1000) / 1000),
    cueMs: 0,
    dropMs: null,
    reason: "crossfade",
    startMs: input.outgoingPositionMs,
    beatPeriodMs: null,
  });
}

function expectGrid(time: number, phase: number, period: number): void {
  expect((time - phase) / period).toBeCloseTo(Math.round((time - phase) / period), 8);
}

describe("planner diagnostics", () => {
  const paths: [string, Partial<AutomixPlanOptions>, AutomixFallbackReason | null][] = [
    ["phrase", {}, null],
    ["energy", { explicitDropMs: 20000 }, null],
    ["invalid position", { outgoingPositionMs: NaN }, "invalid-timing"],
    ["negative position", { outgoingPositionMs: -1 }, "invalid-timing"],
    ["invalid remaining", { outgoingRemainingMs: Infinity }, "invalid-timing"],
    ["reserved tail", { outgoingRemainingMs: 1000 }, "invalid-timing"],
    ["overflow", { outgoingPositionMs: Number.MAX_VALUE }, "invalid-timing"],
    ["invalid duration", { incomingDurationMs: 0 }, "invalid-timing"],
    ["outgoing grid", { outgoingAnalysis: analysis({ bpm: null }) }, "unreliable-outgoing-grid"],
    [
      "incoming grid",
      { incomingAnalysis: analysis({ beatPhaseMs: null }) },
      "unreliable-incoming-grid",
    ],
    [
      "both grids",
      {
        outgoingAnalysis: analysis({ bpm: null }),
        incomingAnalysis: analysis({ bpmConfidence: 0.1 }),
      },
      "unreliable-both-grids",
    ],
    ["tempo", { incomingAnalysis: analysis({ bpm: 130 }) }, "tempo-mismatch"],
    [
      "octave",
      {
        outgoingAnalysis: analysis({ bpm: 90 }),
        incomingAnalysis: analysis({ bpm: 180 }),
      },
      "tempo-mismatch",
    ],
    ["overlap", { outgoingRemainingMs: 1500 }, "insufficient-overlap"],
    [
      "grid window",
      { outgoingPositionMs: 138, outgoingRemainingMs: 3000 },
      "insufficient-grid-window",
    ],
    [
      "unequal grid window",
      {
        outgoingPositionMs: 1,
        outgoingRemainingMs: 2500,
        outgoingAnalysis: analysis({ bpm: 70, beatPhaseMs: 0 }),
        incomingAnalysis: analysis({ bpm: 72 }),
      },
      "insufficient-grid-window",
    ],
    ["duration", { incomingDurationMs: 4000 }, "incoming-duration-limit"],
    [
      "unequal duration",
      {
        incomingAnalysis: analysis({ bpm: 123 }),
        incomingDurationMs: 1200,
      },
      "incoming-duration-limit",
    ],
    ["rejected drop", { explicitDropMs: 100 }, null],
    ["detected drop", { incomingAnalysis: analysis({ dropMs: 20000, dropConfidence: 0.7 }) }, null],
    [
      "invalid fallback",
      { fallbackSeconds: NaN, outgoingAnalysis: analysis({ bpm: null }) },
      "unreliable-outgoing-grid",
    ],
  ];

  it.each(paths)(
    "emits once and preserves the plan for %s, even if the callback throws",
    (_name, overrides, reason) => {
      const input = options(overrides);
      const expected = planAutomix(input);
      for (const throws of [false, true]) {
        const diagnostics: AutomixDiagnostic[] = [];
        const result = planAutomix({
          ...input,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic);
            if (throws) throw new Error("observer failed");
          },
        });
        expect(result).toEqual(expected);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].fallbackReason).toBe(reason);
        expect(diagnostics[0].outcome).toBe(expected?.reason ?? null);
      }
    },
  );

  function diagnose(overrides: Partial<AutomixPlanOptions> = {}): AutomixDiagnostic {
    const diagnostics: AutomixDiagnostic[] = [];
    planAutomix(options({ ...overrides, onDiagnostic: (value) => diagnostics.push(value) }));
    expect(diagnostics).toHaveLength(1);
    return diagnostics[0];
  }

  const issues: [Partial<DjAnalysis>, string][] = [
    [{ bpm: null }, "missing-bpm"],
    [{ bpm: NaN }, "invalid-bpm"],
    [{ bpm: Infinity }, "invalid-bpm"],
    [{ bpm: 69.999 }, "bpm-out-of-range"],
    [{ bpm: 180.001 }, "bpm-out-of-range"],
    [{ bpmConfidence: undefined }, "missing-bpm-confidence"],
    [{ bpmConfidence: NaN }, "invalid-bpm-confidence"],
    [{ bpmConfidence: Infinity }, "invalid-bpm-confidence"],
    [{ bpmConfidence: -0.1 }, "bpm-confidence-out-of-range"],
    [{ bpmConfidence: 1.01 }, "bpm-confidence-out-of-range"],
    [{ bpmConfidence: 0.64999 }, "bpm-confidence-low"],
    [{ beatPhaseConfidence: undefined }, "missing-beat-phase-confidence"],
    [{ beatPhaseConfidence: NaN }, "invalid-beat-phase-confidence"],
    [{ beatPhaseConfidence: Infinity }, "invalid-beat-phase-confidence"],
    [{ beatPhaseConfidence: -0.1 }, "beat-phase-confidence-out-of-range"],
    [{ beatPhaseConfidence: 1.01 }, "beat-phase-confidence-out-of-range"],
    [{ beatPhaseConfidence: 0.64999 }, "beat-phase-confidence-low"],
    [{ beatPhaseMs: null }, "missing-beat-phase"],
    [{ beatPhaseMs: NaN }, "invalid-beat-phase"],
    [{ beatPhaseMs: Infinity }, "invalid-beat-phase"],
    [{ beatPhaseMs: -1 }, "beat-phase-out-of-range"],
    [{ beatPhaseMs: 500 }, "beat-phase-out-of-range"],
  ];
  for (const track of ["outgoing", "incoming"] as const) {
    it.each(issues)(`reports precise ${track} issues for %j`, (overrides, issue) => {
      const diagnostic = diagnose({ [`${track}Analysis`]: analysis(overrides) });
      expect(diagnostic[`${track}GridIssues`]).toEqual([issue]);
      expect(
        diagnostic[track === "outgoing" ? "incomingGridIssues" : "outgoingGridIssues"],
      ).toEqual([]);
    });
  }

  it("reports all issues in a stable order without inventing a phase upper bound for missing BPM", () => {
    expect(
      diagnose({
        outgoingAnalysis: analysis({
          bpm: null,
          bpmConfidence: 0.1,
          beatPhaseConfidence: NaN,
          beatPhaseMs: -1,
        }),
      }).outgoingGridIssues,
    ).toEqual([
      "missing-bpm",
      "bpm-confidence-low",
      "invalid-beat-phase-confidence",
      "beat-phase-out-of-range",
    ]);
  });

  it.each([70, 180])("has no issues at valid boundaries for %s BPM", (bpm) => {
    const grid = analysis({ bpm, bpmConfidence: 0.65, beatPhaseConfidence: 1, beatPhaseMs: 0 });
    const diagnostic = diagnose({ outgoingAnalysis: grid, incomingAnalysis: grid });
    expect(diagnostic.outgoingGridIssues).toEqual([]);
    expect(diagnostic.incomingGridIssues).toEqual([]);
    expect(diagnostic.fallbackReason).toBeNull();
  });

  it.each([1.8499, 1.85, 2, 2.15, 2.1501])(
    "detects octave ratio %s symmetrically without accepting it",
    (ratio) => {
      for (const [a, b] of [
        [80, 80 * ratio],
        [80 * ratio, 80],
      ]) {
        const diagnostic = diagnose({
          outgoingAnalysis: analysis({ bpm: a }),
          incomingAnalysis: analysis({ bpm: b }),
        });
        expect(diagnostic.tempoRatio).toBeCloseTo(ratio, 12);
        expect(diagnostic.octaveRelated).toBe(ratio >= 1.85 && ratio <= 2.15);
        expect(diagnostic.fallbackReason).toBe("tempo-mismatch");
        expect(diagnostic.outcome).toBe("crossfade");
      }
    },
  );

  it.each([null, NaN, Infinity, 0, -120, Number.MIN_VALUE])(
    "sanitizes unusable tempo ratios for %s",
    (bpm) => {
      const diagnostic = diagnose({ outgoingAnalysis: analysis({ bpm }) });
      expect(diagnostic.tempoRatio).toBeNull();
      expect(diagnostic.octaveRelated).toBe(false);
    },
  );

  it("copies only sanitized scalars and timing, including on null results", () => {
    const input = options({
      outgoingAnalysis: analysis({
        bpm: NaN,
        bpmConfidence: Infinity,
        beatPhaseMs: -1,
        beatPhaseConfidence: -Infinity,
        dropMs: Infinity,
        dropConfidence: NaN,
        analyzedDurationMs: Infinity,
      }),
      outgoingPositionMs: NaN,
      outgoingRemainingMs: -1,
      incomingDurationMs: Infinity,
      explicitDropMs: NaN,
      fallbackSeconds: Infinity,
    });
    Object.assign(input.outgoingAnalysis, { url: "private", extra: { value: 1 } });
    const diagnostic = diagnose(input);
    expect(diagnostic.outgoing).toEqual({
      bpm: null,
      bpmCandidate: null,
      bpmConfidence: null,
      beatPhaseMs: -1,
      beatPhaseConfidence: null,
      dropMs: null,
      dropConfidence: null,
      analyzedDurationMs: null,
      onsetCount: null,
      bassOnsetCount: null,
      tempoWindowCoverage: null,
      tempoWindowAgreement: null,
      phaseSupport: null,
      phaseFitQuality: null,
      matchedOnsetCount: null,
      beatCoverage: null,
      beatGridErrorMs: null,
      bassTempoAgreement: null,
      downbeatConfidence: null,
      gridSupportedWindowFraction: null,
      gridMaxDriftMsPerSecond: null,
      gridPhaseSpreadMs: null,
    });
    expect(diagnostic.timing).toEqual({
      outgoingPositionMs: null,
      outgoingRemainingMs: -1,
      incomingDurationMs: null,
      explicitDropMs: null,
      fallbackSeconds: null,
    });
    expect(diagnostic.outcome).toBeNull();
    expect(diagnostic.outgoing).not.toBe(input.outgoingAnalysis);
    expect(diagnostic.incoming).not.toBe(input.incomingAnalysis);
    const before = JSON.stringify(diagnostic);
    input.outgoingAnalysis.beatPhaseMs = 0;
    input.incomingAnalysis.bpm = 90;
    input.outgoingRemainingMs = 5000;
    expect(JSON.stringify(diagnostic)).toBe(before);
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("does not share snapshots, issue arrays, or timing across calls", () => {
    const first = diagnose();
    const second = diagnose();
    expect(first).toEqual(second);
    for (const key of [
      "outgoing",
      "incoming",
      "outgoingGridIssues",
      "incomingGridIssues",
      "timing",
    ] as const) {
      expect(first[key]).not.toBe(second[key]);
    }
  });
});

describe("planAutomix", () => {
  it("schedules 16 beats near the outgoing end using absolute phase", () => {
    expect(planAutomix(options())).toEqual({
      seconds: 8,
      cueMs: 137,
      dropMs: null,
      reason: "tempo-phrase",
      startMs: 31137,
      beatPeriodMs: 500,
    });
  });

  it("rounds the start forward and shortens to whole bars to preserve the tail", () => {
    const input = options({ outgoingPositionMs: 10200 });
    const result = planAutomix(input)!;
    expect(result.startMs).toBe(31637);
    expect(result.seconds).toBe(6);
    expectGrid(result.startMs, 137, 500);
    expect(result.startMs + result.seconds * 1000).toBeLessThanOrEqual(39200);
    expect(result.startMs).toBeGreaterThanOrEqual(10200 + 30000 - 1000 - 8000);
  });

  it("chooses a gridded entry before a reliable energy rise", () => {
    const result = planAutomix(
      options({
        incomingAnalysis: analysis({ dropMs: 20000, dropConfidence: 0.7 }),
      }),
    )!;
    expect(result.reason).toBe("energy-entry");
    expect(result.cueMs).toBe(11637);
    expect(result.dropMs).toBe(20000);
    expectGrid(result.cueMs, 137, 500);
    expect(result.cueMs + result.seconds * 1000).not.toBe(result.dropMs);
  });

  it("prefers an explicit drop, even outside the analyzed window", () => {
    const result = planAutomix(
      options({
        incomingAnalysis: analysis({ dropMs: 20000, dropConfidence: 1 }),
        explicitDropMs: 100000,
        incomingDurationMs: 150000,
      }),
    )!;
    expect(result.dropMs).toBe(100000);
    expect(result.reason).toBe("energy-entry");
    expectGrid(result.cueMs, 137, 500);
  });

  it.each([NaN, Infinity, -1, 50000])("ignores invalid explicit drop %s", (explicitDropMs) => {
    const result = planAutomix(options({ explicitDropMs, incomingDurationMs: 50000 }))!;
    expect(result.reason).toBe("tempo-phrase");
    expect(result.dropMs).toBeNull();
  });

  it("can use a detected drop when the explicit drop is invalid", () => {
    expect(
      planAutomix(
        options({
          explicitDropMs: NaN,
          incomingAnalysis: analysis({ dropMs: 20000, dropConfidence: 0.9 }),
        }),
      )!.dropMs,
    ).toBe(20000);
  });

  it.each([
    { dropMs: 20000, dropConfidence: 0.69999 },
    { dropMs: 20000, dropConfidence: NaN },
    { dropMs: 20000, dropConfidence: Infinity },
    { dropMs: 20000, dropConfidence: 1.1 },
    { dropMs: NaN, dropConfidence: 1 },
    { dropMs: Infinity, dropConfidence: 1 },
    { dropMs: -1, dropConfidence: 1 },
    { dropMs: 90000, dropConfidence: 1 },
    { dropMs: 20000, dropConfidence: 1, analyzedDurationMs: NaN },
  ])("rejects unreliable detected drops: %j", (overrides) => {
    const result = planAutomix(options({ incomingAnalysis: analysis(overrides) }))!;
    expect(result.reason).toBe("tempo-phrase");
    expect(result.dropMs).toBeNull();
  });

  it("does not seek past a drop preceding the first beat", () => {
    const result = planAutomix(options({ explicitDropMs: 100 }))!;
    expect(result.reason).toBe("tempo-phrase");
    expect(result.dropMs).toBeNull();
    expect(result.cueMs).toBe(137);
  });

  for (const track of ["outgoingAnalysis", "incomingAnalysis"] as const) {
    it.each([
      { bpmConfidence: 0.64999 },
      { bpmConfidence: NaN },
      { bpmConfidence: Infinity },
      { bpmConfidence: 1.01 },
      { beatPhaseConfidence: 0.64999 },
      { beatPhaseConfidence: NaN },
      { beatPhaseConfidence: Infinity },
      { beatPhaseConfidence: 1.01 },
      { bpm: null },
      { bpm: NaN },
      { bpm: Infinity },
      { bpm: 69.999 },
      { bpm: 180.001 },
      { beatPhaseMs: null },
      { beatPhaseMs: NaN },
      { beatPhaseMs: Infinity },
      { beatPhaseMs: -1 },
      { beatPhaseMs: 500 },
    ])(`never seeks with an unreliable ${track}: %j`, (overrides) => {
      expectFallback(options({ [track]: analysis(overrides), explicitDropMs: 20000 }));
    });
  }

  it.each([70, 180])("accepts inclusive BPM and confidence boundaries at %s BPM", (bpm) => {
    const grid = analysis({ bpm, bpmConfidence: 0.65, beatPhaseConfidence: 0.65, beatPhaseMs: 0 });
    expect(planAutomix(options({ outgoingAnalysis: grid, incomingAnalysis: grid }))!.reason).toBe(
      "tempo-phrase",
    );
  });

  it.each([
    [100, 103],
    [103, 100],
  ])("accepts exactly 3%% difference: %s / %s", (outBpm, inBpm) => {
    const result = planAutomix(
      options({
        outgoingAnalysis: analysis({ bpm: outBpm }),
        incomingAnalysis: analysis({ bpm: inBpm }),
        explicitDropMs: 20000,
      }),
    )!;
    expect(result.reason).toBe("energy-entry");
    expect(result.beatPeriodMs).toBe(60000 / outBpm);
    expectGrid(result.startMs, 137, 60000 / outBpm);
    expectGrid(result.cueMs, 137, 60000 / inBpm);
    // No speed / stretch / sync instruction is exposed by a timing-only plan.
    expect(Object.keys(result).sort()).toEqual([
      "beatPeriodMs",
      "cueMs",
      "dropMs",
      "reason",
      "seconds",
      "startMs",
    ]);
  });

  it.each([
    [120, 123],
    [123, 120],
    [100, 103],
    [103, 100],
    [120, 121],
  ])("bounds accumulated drift without stretching: %s / %s", (outBpm, inBpm) => {
    const outPeriod = 60 / outBpm;
    const inPeriod = 60 / inBpm;
    const result = planAutomix(
      options({
        outgoingAnalysis: analysis({ bpm: outBpm }),
        incomingAnalysis: analysis({ bpm: inBpm }),
      }),
    )!;
    expect(result.reason).toBe("tempo-phrase");
    expect(result.seconds * Math.abs(1 - outPeriod / inPeriod)).toBeLessThan(
      Math.min(outPeriod, inPeriod) / 16,
    );
    const beats = result.seconds / outPeriod;
    expect(beats).toBeGreaterThanOrEqual(1);
    expect(beats).toBeCloseTo(Math.round(beats), 8);
    expectGrid(result.startMs, 137, outPeriod * 1000);
    expect(result.startMs + result.seconds * 1000).toBeLessThanOrEqual(39137);
    if (outBpm === 120 && inBpm === 123) expect(result.seconds).toBe(1);
    if (outBpm === 120 && inBpm === 121) expect(beats).toBe(4);
  });

  it("uses a single beat when start rounding leaves less than two beats", () => {
    const result = planAutomix(
      options({
        incomingAnalysis: analysis({ bpm: 123 }),
        outgoingPositionMs: 10200,
      }),
    )!;
    expect(result.reason).toBe("tempo-phrase");
    expect(result.seconds).toBe(0.5);
    expect(result.startMs).toBe(38637);
  });

  it("caps unequal-tempo fallback at one second when no beat-start overlap fits", () => {
    const input = options({
      outgoingPositionMs: 1,
      outgoingRemainingMs: 2500,
      outgoingAnalysis: analysis({ bpm: 70, beatPhaseMs: 0 }),
      incomingAnalysis: analysis({ bpm: 72, dropMs: 20000, dropConfidence: 1 }),
      explicitDropMs: 20000,
    });
    expect(planAutomix(input)).toEqual({
      seconds: 1,
      cueMs: 0,
      dropMs: null,
      reason: "crossfade",
      startMs: 1,
      beatPeriodMs: null,
    });
  });

  it("still respects shorter fallback and duration caps with unequal tempos", () => {
    const input = options({
      incomingAnalysis: analysis({ bpm: 123 }),
      incomingDurationMs: 1200,
    });
    expect(planAutomix(input)!.seconds).toBe(0.3);
    expect(planAutomix({ ...input, fallbackSeconds: 0.1 })!.seconds).toBe(0.1);
    expect(planAutomix(input)!.cueMs).toBe(0);
    expect(planAutomix(input)!.reason).toBe("crossfade");
  });

  it.each([
    [100, 103.001],
    [103.001, 100],
    [90, 180],
  ])("falls back for incompatible %s / %s", (a, b) => {
    expectFallback(
      options({
        outgoingAnalysis: analysis({ bpm: a }),
        incomingAnalysis: analysis({ bpm: b }),
        explicitDropMs: 20000,
      }),
    );
  });

  it.each([NaN, Infinity, -Infinity, -1])(
    "rejects invalid outgoing position %s",
    (outgoingPositionMs) => {
      expect(planAutomix(options({ outgoingPositionMs }))).toBeNull();
    },
  );

  it.each([NaN, Infinity, -Infinity, -1, 0, 999, 1000])(
    "rejects unusable remaining time %s",
    (outgoingRemainingMs) => {
      expect(planAutomix(options({ outgoingRemainingMs }))).toBeNull();
    },
  );

  it("rejects overflowing outgoing end times", () => {
    expect(planAutomix(options({ outgoingPositionMs: Number.MAX_VALUE }))).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, -1, 0])(
    "rejects supplied invalid incoming duration %s",
    (incomingDurationMs) => {
      expect(planAutomix(options({ incomingDurationMs }))).toBeNull();
    },
  );

  it.each([NaN, Infinity, -Infinity, -1, 0])(
    "sanitizes fallback seconds %s to eight seconds",
    (fallbackSeconds) => {
      expect(
        planAutomix(options({ outgoingAnalysis: analysis({ bpm: null }), fallbackSeconds }))!
          .seconds,
      ).toBe(8);
    },
  );

  it("bounds fallback by 16 seconds, remaining minus a second, and incoming quarter", () => {
    const base = options({ outgoingAnalysis: analysis({ bpm: null }), fallbackSeconds: 100 });
    expect(planAutomix(base)!.seconds).toBe(16);
    expect(planAutomix({ ...base, outgoingRemainingMs: 2500 })!.seconds).toBe(1.5);
    expect(planAutomix({ ...base, incomingDurationMs: 6000 })!.seconds).toBe(1.5);
    expect(planAutomix({ ...base, outgoingRemainingMs: 1000.001 })!.seconds).toBeCloseTo(0.000001);
  });

  it("uses a shorter whole-bar overlap when the incoming quarter limits it", () => {
    const result = planAutomix(options({ incomingDurationMs: 17000 }))!;
    expect(result.seconds).toBe(4);
    expect(result.seconds * 1000).toBeLessThanOrEqual(17000 / 4);
    expect(Number.isInteger(result.seconds / 2)).toBe(true);
  });

  it("falls back when no complete bar fits or no beat-start overlap fits", () => {
    expect(planAutomix(options({ incomingDurationMs: 4000 }))!.reason).toBe("crossfade");
    expect(
      planAutomix(options({ outgoingPositionMs: 138, outgoingRemainingMs: 3000 }))!.reason,
    ).toBe("crossfade");
  });

  it("allows an immediate beat at position zero", () => {
    const result = planAutomix(
      options({
        outgoingPositionMs: 0,
        outgoingRemainingMs: 9000,
        outgoingAnalysis: analysis({ beatPhaseMs: 0 }),
      }),
    )!;
    expect(result.startMs).toBe(0);
    expect(result.seconds).toBe(8);
  });

  it("is deterministic and does not mutate analysis when extrapolating past 90 seconds", () => {
    const input = Object.freeze(
      options({
        outgoingPositionMs: 180137,
        outgoingAnalysis: Object.freeze(analysis()),
        incomingAnalysis: Object.freeze(analysis({ dropMs: 20000, dropConfidence: 0.9 })),
      }),
    );
    const before = JSON.stringify(input);
    const first = planAutomix(input)!;
    expect(first).toEqual(planAutomix(input));
    expect(first.startMs).toBe(201137);
    expect(JSON.stringify(input)).toBe(before);
  });
});
