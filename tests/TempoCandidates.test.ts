import { describe, expect, it } from "vitest";
import {
  selectTempoCandidate,
  type TempoCandidate,
  type TempoWindow,
} from "../src/Audio/analysis/TempoCandidates.js";

function window(startSeconds: number, ...peaks: [number, number][]): TempoWindow {
  return {
    startSeconds,
    candidates: peaks.map(([bpm, strength]) => ({ bpm, strength })),
  };
}

describe("selectTempoCandidate", () => {
  it("selects dominant 104 BPM over two stronger 136 BPM windows", () => {
    const result = selectTempoCandidate([
      window(0, [103.5, 0.7]),
      window(10, [104, 0.75]),
      window(20, [104.5, 0.8]),
      window(30, [104, 0.75]),
      window(40, [136, 0.95]),
      window(50, [136.5, 0.95]),
    ]);

    expect(result).toEqual({
      bpm: 104,
      strength: 0.75,
      agreement: 4 / 6,
      coverage: 4 / 6,
      ambiguity: 1.9 / 3,
    });
  });

  it("lets a persistent runner-up beat varying strongest distractions", () => {
    const result = selectTempoCandidate([
      window(0, [80, 0.95], [104.5, 0.6]),
      window(10, [130, 0.96], [105, 0.65]),
      window(20, [155, 0.97], [105.5, 0.7]),
      window(30, [185, 0.98], [105, 0.65]),
    ]);

    expect(result?.bpm).toBe(105);
    expect(result?.strength).toBe(0.65);
    expect(result?.agreement).toBe(1);
    expect(result?.coverage).toBe(1);
    expect(result?.ambiguity).toBeCloseTo(0.98 / 2.6);
  });

  it("does not multiply a window's vote for nearby or exact duplicates", () => {
    const windows = [window(0, [105, 0.8], [140, 0.7]), window(10, [140, 0.7])];
    const original = selectTempoCandidate(windows);
    const duplicated = selectTempoCandidate([
      {
        ...windows[0],
        candidates: [
          ...windows[0].candidates,
          ...Array.from({ length: 20 }, (_, index) => ({
            bpm: 104 + index / 10,
            strength: 0.79,
          })),
          { bpm: 105, strength: 0.8 },
        ],
      },
      windows[1],
    ]);

    expect(duplicated).toEqual(original);
    expect(original?.bpm).toBe(140);
    expect(original?.ambiguity).toBeCloseTo(0.8 / 1.4);
  });

  it.each([
    [70, 140],
    [140, 70],
    [105, 140],
    [140, 105],
  ])("keeps %i and %i BPM distinct without a musical preference", (winner, other) => {
    const result = selectTempoCandidate([
      window(0, [winner, 0.8], [other, 0.75]),
      window(10, [winner, 0.8], [other, 0.75]),
      window(20, [winner, 0.8], [other, 0.75]),
    ]);

    expect(result?.bpm).toBe(winner);
    expect(result?.strength).toBe(0.8);
    expect(result?.ambiguity).toBeCloseTo(0.75 / 0.8);
  });

  it("reports full ambiguity for equal half/double scores", () => {
    expect(selectTempoCandidate([window(0, [70, 0.8], [140, 0.8])])).toEqual({
      bpm: 140,
      strength: 0.8,
      agreement: 1,
      coverage: 1,
      ambiguity: 1,
    });
  });

  it("deduplicates nearby hypotheses and uses a robust median center", () => {
    const result = selectTempoCandidate([
      window(0, [100, 0.6]),
      window(10, [100.2, 0.7]),
      window(20, [100.4, 0.8]),
      window(30, [102.4, 0.9]),
    ]);
    expect(result?.bpm).toBeCloseTo(100.3);
    expect(result).toMatchObject({ strength: 0.75, agreement: 1, coverage: 1, ambiguity: 0 });
  });

  it("uses a 2.5% relative neighborhood, not absolute BPM distance or chaining", () => {
    const result = selectTempoCandidate([
      window(0, [100, 0.8]),
      window(10, [102.5, 0.8]),
      window(20, [106, 0.8]),
      window(30, [109, 0.8]),
    ]);

    expect(result?.bpm).toBe(101.25);
    expect(result?.coverage).toBe(0.5);
    expect(result?.ambiguity).toBe(0.5);
  });

  it("is independent of window and candidate order, including tied votes", () => {
    const windows = [
      window(0, [105, 0.1], [106, 0.1], [140, 0.7]),
      window(10, [105, 0.2], [155, 0.8]),
      window(20, [104.5, 0.8], [180, 0.8]),
      window(30, [105.5, 0.9], [75, 0.8]),
    ];
    const expected = selectTempoCandidate(windows);
    for (let offset = 0; offset < windows.length; offset++) {
      const reordered = [...windows.slice(offset), ...windows.slice(0, offset)]
        .reverse()
        .map((entry) => ({ ...entry, candidates: [...entry.candidates].reverse() }));
      expect(selectTempoCandidate(reordered)).toEqual(expected);
    }
  });

  it("separates agreement from coverage and ignores invalid candidates and windows", () => {
    const invalid: TempoCandidate[] = [
      { bpm: NaN, strength: 0.9 },
      { bpm: Infinity, strength: 0.9 },
      { bpm: 0, strength: 0.9 },
      { bpm: -105, strength: 0.9 },
      ...[NaN, Infinity, -Infinity, -1, 0, 1.1].map((strength) => ({ bpm: 105, strength })),
    ];
    const windows = [
      { startSeconds: 0, candidates: [...invalid, { bpm: 105, strength: 0.6 }] },
      window(10, [105, 0.8]),
      window(20, [140, 0.9]),
      window(30),
      { startSeconds: 40, candidates: invalid },
      window(NaN, [105, 1]),
      window(Infinity, [105, 1]),
      window(-1, [105, 1]),
    ];

    expect(selectTempoCandidate(windows)).toEqual({
      bpm: 105,
      strength: 0.7,
      agreement: 2 / 3,
      coverage: 2 / 8,
      ambiguity: 0.9 / 1.4,
    });
    expect(selectTempoCandidate([])).toBeNull();
    expect(selectTempoCandidate([window(0)])).toBeNull();
    expect(selectTempoCandidate([{ startSeconds: 0, candidates: invalid }])).toBeNull();
  });

  it("accepts a single valid candidate without inventing extra support", () => {
    const windows = [window(0, [123, 1]), window(10)];
    const before = structuredClone(windows);
    expect(selectTempoCandidate(windows)).toEqual({
      bpm: 123,
      strength: 1,
      agreement: 1,
      coverage: 0.5,
      ambiguity: 0,
    });
    expect(windows).toEqual(before);
  });
});
