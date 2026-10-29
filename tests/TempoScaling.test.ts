import { describe, expect, it } from "vitest";
import { analyzePcm } from "../src/Audio/analysis/DjAnalysisCore.js";
import { compareScaledTempo, compareScaledBeats } from "../scripts/tempo-scaling-metrics.mjs";

const rate = 4000;
function fixture(bpm: number) {
  const pcm = new Int16Array(30 * rate);
  const times: number[] = [];
  for (let t = 0.311; t < 29.95; t += 60 / bpm) {
    const start = Math.round(t * rate);
    times.push((start / rate) * 1000);
    for (let i = 0; i < 48; i++)
      pcm[start + i] = Math.round(26000 * Math.exp(-i / 12) * Math.cos(i * 1.7));
  }
  return { pcm, times };
}
// Independent time-axis transform of existing samples, not regenerated clicks
// using the BPM the analyzer is expected to return. This also changes pitch.
function resampleSpeed(pcm: Int16Array, speed: number) {
  const output = new Int16Array(Math.floor(pcm.length / speed));
  for (let i = 0; i < output.length; i++) {
    const position = i * speed,
      index = Math.floor(position),
      fraction = position - index;
    output[i] = Math.round(
      pcm[index]! * (1 - fraction) + (pcm[index + 1] ?? pcm[index]!) * fraction,
    );
  }
  return output;
}

describe("tempo scaling metrics", () => {
  it.fails("known diagnostic ambiguity: stable faster 3:2 hypothesis is not auto-selected", async () => {
    const { selectTempoCandidate } = await import("../src/Audio/analysis/DjAnalysisCore.js");
    const result = selectTempoCandidate([
      {
        startSeconds: 0,
        candidates: [
          { bpm: 72, strength: 0.5 },
          { bpm: 108, strength: 0.35 },
        ],
      },
      {
        startSeconds: 10,
        candidates: [
          { bpm: 72, strength: 0.5 },
          { bpm: 107, strength: 0.35 },
        ],
      },
      {
        startSeconds: 20,
        candidates: [
          { bpm: 72, strength: 0.5 },
          { bpm: 107, strength: 0.35 },
        ],
      },
    ]);
    expect(result?.bpm).toBeCloseTo(107, 0);
  });
  it("does not confuse octave-family consistency with correct BPM", () => {
    const metric = compareScaledTempo(100, 210, 1.05);
    expect(metric.relativeError).toBe(1);
    expect(metric.octaveShift).toBe(1);
    expect(metric.familyErrorOctaves).toBe(0);
    expect(metric.octaveCorrectedRelativeError).toBe(0);
  });
  it("distinguishes non-octave metric rivals", () => {
    expect(compareScaledTempo(103, 136, 1).familyErrorOctaves).toBeGreaterThan(0.3);
  });
  it("counts missing beats and forbids duplicate matching", () => {
    const r = compareScaledBeats([100, 600, 1100], [50, 50, 550], 2, 1);
    expect(r.matched).toBe(2);
    expect(r.precision).toBe(2 / 3);
    expect(r.recall).toBe(2 / 3);
    expect(r.meanMatchedErrorMs).toBe(0);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid speed %s", (speed) => {
    expect(() => compareScaledTempo(100, 100, speed)).toThrow(RangeError);
    expect(() => compareScaledBeats([], [], speed)).toThrow(RangeError);
  });
});

describe("PCM tempo/time scaling equivariance", () => {
  it.each(
    [90, 100, 120, 150].flatMap((bpm) =>
      [0.92, 1, 1.08].filter((speed) => bpm !== 150 || speed !== 1.08).map((speed) => [bpm, speed]),
    ),
  )("preserves metrical level for %s BPM at speed %s", (bpm, speed) => {
    const original = fixture(bpm!);
    const scaled = resampleSpeed(original.pcm, speed!);
    const result = analyzePcm(scaled, rate);
    expect(result.bpm).not.toBeNull();
    const metric = compareScaledTempo(bpm, result.bpm!, speed);
    expect(metric.relativeError).toBeLessThan(0.003);
    expect(metric.octaveShift).toBe(0);
    const beats = compareScaledBeats(original.times, result.beatTracking!.beatTimesMs, speed, 30);
    expect(beats.precision).toBeGreaterThan(0.95);
    expect(beats.recall).toBeGreaterThan(0.85);
    expect(beats.meanMatchedErrorMs).toBeLessThan(15);
    expect(Math.abs(result.analyzedDurationMs - 30000 / speed!)).toBeLessThan(1);
    const period = 60000 / (bpm! * speed!);
    const expectedPhase = 311 / speed!;
    const delta = Math.abs(result.beatPhaseMs! - expectedPhase) % period;
    expect(Math.min(delta, period - delta)).toBeLessThan(15);
  });
  it.fails("known failure: 150 BPM accelerated 8% must remain 162 BPM, not half-time", () => {
    const result = analyzePcm(resampleSpeed(fixture(150).pcm, 1.08), rate);
    expect(result.bpm).not.toBeNull();
    expect(compareScaledTempo(150, result.bpm!, 1.08).relativeError).toBeLessThan(0.003);
  });
});
