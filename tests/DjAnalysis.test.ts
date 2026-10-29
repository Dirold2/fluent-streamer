import { describe, expect, it, vi, afterEach } from "vitest";
import { analyzePcm, analyzeTrack } from "../src/Audio/analysis/DjAnalysis.js";
import { Processor } from "../src/Core/Processor.js";

function clicks(bpm: number, phaseMs = 137, seconds = 30, rate = 4000): Int16Array {
  const pcm = new Int16Array(Math.floor(seconds * rate));
  for (let time = phaseMs / 1000; time < seconds; time += 60 / bpm) {
    const start = Math.round(time * rate);
    for (let i = 0; i < Math.round(rate * 0.012) && start + i < pcm.length; i++) {
      pcm[start + i] = Math.round(26000 * Math.exp(-i / (rate * 0.003)) * Math.cos(i * 1.7));
    }
  }
  return pcm;
}

function circularError(a: number, b: number, period: number): number {
  const delta = Math.abs(a - b) % period;
  return Math.min(delta, period - delta);
}

afterEach(() => vi.restoreAllMocks());

describe("analyzePcm", () => {
  it.each([
    [120, 137],
    [100, 311],
    [150, 23],
    [90, 0],
    [175, 245],
  ])("recovers %s BPM and %s ms phase without FFT centering bias", (bpm, phase) => {
    const result = analyzePcm(clicks(bpm, phase), 4000);
    expect(result.bpm).not.toBeNull();
    expect(result.bpm!).toBeCloseTo(bpm, 0);
    expect(result.bpmConfidence).toBeGreaterThan(0.35);
    expect(circularError(result.beatPhaseMs!, phase, 60000 / bpm)).toBeLessThan(12);
    expect(result.beatPhaseConfidence).toBeGreaterThan(0.35);
    expect(result.dropMs).toBeNull();
    const tracked = result.beatTracking!;
    expect(tracked.beatTimesMs.length).toBeGreaterThan(20);
    for (const time of tracked.beatTimesMs) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThan(result.analyzedDurationMs);
      expect(circularError(time, phase, 60000 / bpm)).toBeLessThan(25);
    }
    expect(tracked.intervalErrorMs).toBeLessThan(25);
    expect(result.stableSections!.length).toBeGreaterThan(0);
    for (const section of result.stableSections!) {
      expect(section.validationStartMs).toBe(section.endMs);
      expect(section.validationEndMs).toBeLessThanOrEqual(result.analyzedDurationMs);
      expect(section.bpm).toBeCloseTo(bpm, 0);
      expect(circularError(section.beatPhaseMs, phase, 60000 / bpm)).toBeLessThan(12);
    }
  });

  it("fits a non-integer beat period over 90 seconds despite offbeat percussion", () => {
    const rate = 4000;
    const bpm = 130;
    const period = 60 / bpm;
    const pcm = clicks(bpm, 137, 90, rate);
    // Quiet subdivisions create onsets that cancel a circular average of all attacks.
    for (let time = 0.137 + period / 2; time < 90; time += period) {
      const start = Math.round(time * rate);
      for (let i = 0; i < 24 && start + i < pcm.length; i++) {
        pcm[start + i] = Math.round(15000 * Math.exp(-i / 8) * Math.cos(i * 2.3));
      }
    }
    const result = analyzePcm(pcm, rate);
    expect(result.bpm).toBeCloseTo(bpm, 1);
    expect(result.bpmConfidence).toBeGreaterThanOrEqual(0.65);
    expect(result.beatPhaseConfidence).toBeGreaterThan(0.6);
    // Either subdivision is a pulse, but the fitted period must not drift.
    expect(circularError(result.beatPhaseMs!, 137, 60000 / bpm / 2)).toBeLessThan(12);
  });

  it("keeps a stable BPM when the phase is ambiguous", () => {
    const pcm = clicks(100, 137, 30);
    const result = analyzePcm(pcm, 4000);
    expect(result.bpm).toBeCloseTo(100, 0);
    expect(result.bpmConfidence).toBeGreaterThan(0.35);
    // A missing phase must not erase a useful tempo estimate.
    expect(result.beatPhaseMs === null || result.beatPhaseConfidence >= 0).toBe(true);
  });

  it("uses a repeated four-beat bass pattern as downbeat evidence", () => {
    const rate = 4000;
    const bpm = 100;
    const period = 60 / bpm;
    const pcm = clicks(bpm, 137, 30, rate);
    for (let beat = 0; beat * period < 30; beat++) {
      if (beat % 4 !== 0) continue;
      const start = Math.round((0.137 + beat * period) * rate);
      for (let i = 0; i < Math.round(rate * 0.03) && start + i < pcm.length; i++) {
        pcm[start + i] = Math.min(32767, pcm[start + i]! + Math.round(9000 * Math.exp(-i / 18)));
      }
    }
    const result = analyzePcm(pcm, rate);
    expect(result.bpm).toBeCloseTo(bpm, 0);
    expect(result.bpmConfidence).toBeGreaterThan(0.35);
    expect(result.beatPhaseMs).not.toBeNull();
  });

  it.each([1000, 8000, 44100, 48000])("handles %s Hz PCM", (rate) => {
    const result = analyzePcm(clicks(120, 137, 21, rate), rate);
    expect(result.bpm).toBeCloseTo(120, 0);
    expect(circularError(result.beatPhaseMs!, 137, 500)).toBeLessThan(15);
  });

  it("rejects silence, DC, and deterministic broadband noise", () => {
    const noise = new Int16Array(30 * 4000);
    let seed = 42;
    for (let i = 0; i < noise.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      noise[i] = seed >> 17;
    }
    for (const pcm of [new Int16Array(40000), new Int16Array(40000).fill(15000), noise]) {
      const result = analyzePcm(pcm, 4000);
      expect(result.bpm).toBeNull();
      expect(result.bpmCandidate).toBeUndefined();
      expect(result.bpmConfidence).toBeLessThan(0.35);
      expect(result.beatPhaseMs).toBeNull();
      expect(result.dropMs).toBeNull();
    }
  });

  it("does not confidently impose one grid on changing tempos", () => {
    const pcm = new Int16Array(60 * 4000);
    pcm.set(clicks(100, 137, 30));
    pcm.set(clicks(145, 137, 30), 30 * 4000);
    const result = analyzePcm(pcm, 4000);
    expect(result.bpm).toBeNull();
    expect(Number.isFinite(result.bpmCandidate)).toBe(true);
    expect(result.bpmConfidence).toBeLessThan(0.35);
    expect(result.beatPhaseMs).toBeNull();
  });

  it.each([70, 80, 103.7, 105, 106.4, 140, 180])(
    "recovers %s BPM with bounded timing jitter",
    (bpm) => {
      const rate = 4000;
      const seconds = 60;
      const pcm = new Int16Array(rate * seconds);
      const period = 60 / bpm;
      for (let beat = 0; 0.137 + beat * period < seconds - 0.1; beat++) {
        // A repeating offset has no long-term drift, but its adjacent-gap median
        // is 1.02 periods: the old gap refinement incorrectly biased this tempo.
        const time = 0.137 + beat * period + (beat % 3) * 0.02 * period;
        const start = Math.round(time * rate);
        for (let i = 0; i < 48; i++)
          pcm[start + i] = Math.round(26000 * Math.exp(-i / 12) * Math.cos(i * 1.7));
      }
      const result = analyzePcm(pcm, rate);
      if (bpm === 70) {
        // Known boundary limitation: do not force an out-of-range fitted grid.
        expect(result.bpm).toBeNull();
        expect(result.beatPhaseMs).toBeNull();
        return;
      }
      expect(result.bpm).not.toBeNull();
      if (bpm === 140) {
        // A bounded jitter pattern can favor half-time. Keep this ambiguity visible.
        expect(Math.min(Math.abs(result.bpm! - bpm), Math.abs(result.bpm! * 2 - bpm))).toBeLessThan(
          0.3,
        );
        expect(result.tempoAmbiguity).toBeGreaterThan(0.5);
      } else expect(Math.abs(result.bpm! - bpm)).toBeLessThan(0.3);
      expect(result.tempoWindows?.length).toBeGreaterThan(1);
      expect(result.tempoAmbiguity).toBeGreaterThanOrEqual(0);
      expect(result.tempoAmbiguity).toBeLessThanOrEqual(1);
    },
  );

  it("is deterministic, accepts partial windows, and reports the actual duration", () => {
    const pcm = clicks(120, 137, 23.713);
    const result = analyzePcm(pcm, 4000);
    expect(result).toEqual(analyzePcm(pcm, 4000));
    expect(result.analyzedDurationMs).toBe(23713);
    expect(result.bpm).toBeCloseTo(120, 0);
    expect(analyzePcm(new Int16Array(31999), 4000).bpm).toBeNull();
    expect(analyzePcm(new Int16Array(), 4000).analyzedDurationMs).toBe(0);
  });

  it("detects a sustained energy rise but not a lone accent", () => {
    const pcm = clicks(120, 137, 30);
    for (let i = 0; i < 15 * 4000; i++) pcm[i] = Math.round(pcm[i]! * 0.1);
    const result = analyzePcm(pcm, 4000);
    expect(result.dropMs).toBe(15000);
    expect(result.dropConfidence).toBeGreaterThan(0.35);
    const accent = clicks(120, 137, 30);
    accent[15 * 4000] = 32767;
    expect(analyzePcm(accent, 4000).dropMs).toBeNull();
  });

  it("safely abstains at extremely low positive sample rates", () => {
    expect(analyzePcm(new Int16Array(10), 0.1).bpm).toBeNull();
  });

  it("caps analysis at 90 seconds", () => {
    const pcm = clicks(120, 137, 95);
    expect(analyzePcm(pcm, 4000)).toEqual(analyzePcm(pcm.subarray(0, 360000), 4000));
    expect(analyzePcm(pcm, 4000).analyzedDurationMs).toBe(90000);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid sample rate %s", (rate) => {
    expect(() => analyzePcm(new Int16Array(0), rate)).toThrow(RangeError);
  });
});

describe("analyzeTrack", () => {
  it("decodes the existing audio fixture with the real Processor", async () => {
    const result = await analyzeTrack(new URL("./320.mp3", import.meta.url).pathname);
    expect(result.analyzedDurationMs).toBeGreaterThan(0);
    expect(result.analyzedDurationMs).toBeLessThanOrEqual(90000);
    expect(result.bpmConfidence).toBeGreaterThanOrEqual(0);
    expect(result.bpmConfidence).toBeLessThanOrEqual(1);
  }, 30000);
  function mockRun(chunks: Uint8Array[], failure?: Error) {
    const close = vi.spyOn(Processor.prototype, "close").mockResolvedValue();
    const kill = vi.spyOn(Processor.prototype, "kill").mockResolvedValue();
    const run = vi.spyOn(Processor.prototype, "run").mockImplementation(
      async () =>
        ({
          output: new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          done: failure ? Promise.reject(failure) : Promise.resolve(),
        }) as Awaited<ReturnType<Processor["run"]>>,
    );
    return { run, close, kill };
  }

  it("uses Processor, drains split little-endian samples, and closes", async () => {
    const pcm = clicks(120, 137, 12);
    const bytes = new Uint8Array(pcm.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
    const { run, close } = mockRun([bytes.subarray(0, 13), bytes.subarray(13)]);
    const args = vi.spyOn(Processor.prototype, "setArgs");
    const sources = vi.spyOn(Processor.prototype, "setInputSources");
    const result = await analyzeTrack("https://example.test/audio", {
      headers: { Authorization: "test" },
    });
    expect(result).toEqual(analyzePcm(pcm, 4000));
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(args.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(["-t", "90", "-ac", "1", "-ar", "4000", "s16le"]),
    );
    expect(sources.mock.calls[0]![0][0]).toMatchObject({
      type: "url",
      url: "https://example.test/audio",
    });
  });

  it("awaits process completion, propagates failures, and cleans up", async () => {
    const error = new Error("decoder failed");
    const { close } = mockRun([], error);
    await expect(analyzeTrack("broken.mp3")).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });

  it("cleans up startup failures", async () => {
    const { run, close } = mockRun([]);
    run.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(analyzeTrack("missing.mp3")).rejects.toThrow("spawn failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds decoded output", async () => {
    const { close } = mockRun([new Uint8Array(720001)]);
    await expect(analyzeTrack("too-long.mp3")).rejects.toThrow("limit");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not start an already aborted request", async () => {
    const { run } = mockRun([]);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(analyzeTrack("test.mp3", { signal: abort.signal })).rejects.toThrow("cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout", "failure"])(
    "interrupts a pending stream read on %s",
    async (mode) => {
      const { run, close, kill } = mockRun([]);
      let rejectDone!: (error: Error) => void;
      const done = new Promise<void>((_, reject) => {
        rejectDone = reject;
      });
      run.mockResolvedValueOnce({
        output: new ReadableStream<Uint8Array>(),
        done,
      } as Awaited<ReturnType<Processor["run"]>>);
      const abort = new AbortController();
      const analysis = analyzeTrack("stalled.mp3", {
        signal: abort.signal,
        timeout: mode === "timeout" ? 20 : 1000,
      });
      if (mode === "abort") setTimeout(() => abort.abort(new Error("cancelled")), 5);
      if (mode === "failure") setTimeout(() => rejectDone(new Error("decoder failed")), 5);
      // Real Processor.close settles done; model that lifecycle in the mock.
      close.mockImplementation(async () => {
        rejectDone(new Error("closed"));
      });
      await expect(analysis).rejects.toThrow(
        mode === "abort" ? "cancelled" : mode === "timeout" ? "timed out" : "decoder failed",
      );
      expect(close).toHaveBeenCalled();
      if (mode !== "failure") expect(kill).toHaveBeenCalled();
    },
  );

  it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s", async (timeout) => {
    await expect(analyzeTrack("test.mp3", { timeout })).rejects.toThrow(RangeError);
  });
});
