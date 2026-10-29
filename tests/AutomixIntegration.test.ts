import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  FluentStream,
  planAutomix,
  type DjAnalysis,
  type AutomixDiagnostic,
} from "../src/index.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";
import * as analysis from "../src/Audio/analysis/DjAnalysis.js";
import { PlaybackMixer } from "../src/Audio/PlaybackMixer.js";
import Processor from "../src/Core/Processor.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const directory = mkdtempSync(join(tmpdir(), "automix-integration-"));
const fixture = join(directory, "tone.wav");
if (hasFFmpeg) {
  const generated = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-ar",
    "48000",
    "-ac",
    "2",
    fixture,
  ]);
  if (generated.status !== 0) throw new Error(generated.stderr.toString());
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const unknown: DjAnalysis = {
  bpm: null,
  bpmConfidence: 0,
  beatPhaseMs: null,
  beatPhaseConfidence: 0,
  dropMs: null,
  dropConfidence: 0,
  analyzedDurationMs: 90000,
};
const grid: DjAnalysis = {
  ...unknown,
  bpm: 120,
  bpmConfidence: 0.9,
  beatPhaseMs: 0,
  beatPhaseConfidence: 0.9,
};
const runs: FFmpegRunResultExtended[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await Promise.all(
    readers.splice(0).map(async (reader) => {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }),
  );
  vi.restoreAllMocks();
});
function track() {
  return new FluentStream({
    enableCrossfade: true,
    autoDrainOutput: false,
    disableThrottling: true,
  })
    .input(fixture)
    .audioCodec("pcm_s16le")
    .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
    .output(FluentStream.stdout);
}
async function run(fluent: FluentStream) {
  const result = await fluent.run();
  runs.push(result);
  const reader = result.output.getReader();
  readers.push(reader);
  return { result, reader };
}
const cached = {
  outgoingRemainingMs: 10000,
  outgoingAnalysis: unknown,
  incomingAnalysis: unknown,
  fallbackSeconds: 0.04,
};

// These exercise real decoder ownership and pull-driven PCM, not wall-clock timers.
describe.skipIf(!hasFFmpeg)("automix preparation integration", () => {
  it("preserves explicit mid-track start rather than replacing it with the tail", async () => {
    const fluent = track();
    await run(fluent);
    const prepared = await fluent.prepareAutomix(fixture, {
      ...cached,
      transitionMode: "beat-handoff",
      transitionOverride: { startMs: 3000, cueMs: 1000, seconds: 0.5 },
    });
    expect(prepared.plan.startMs).toBe(3000);
    expect(prepared.plan.cueMs).toBe(1000);
    expect(prepared.plan.seconds).toBe(0.5);
    expect(prepared.plan.reason).toBe("tempo-phrase");
    await prepared.cancel();
  });
  it.each([-1, NaN, Infinity, 9900])("rejects an invalid explicit start %s", async (startMs) => {
    const fluent = track();
    await run(fluent);
    await expect(
      fluent.prepareAutomix(fixture, {
        ...cached,
        transitionOverride: { startMs, cueMs: 0, seconds: 0.5 },
      }),
    ).rejects.toThrow("invalid transitionOverride");
  });

  it.each([undefined, "beat-handoff"] as const)(
    "prepares and starts once with mode %s",
    async (transitionMode) => {
      const fluent = track();
      const { reader } = await run(fluent);
      const prepare = vi.spyOn(PlaybackMixer.prototype, "crossfadePrepared");
      const prepared = await fluent.prepareAutomix(fixture, { ...cached, transitionMode });
      expect(prepared.plan.reason).toBe("crossfade");
      for (let i = 0; i < 3; i++) expect((await reader.read()).done).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      await expect(fluent.seek(1)).rejects.toThrow("crossfade");
      await expect(fluent.crossfade(fixture)).rejects.toThrow("active");
      await expect(fluent.prepareAutomix(fixture, cached)).rejects.toThrow("active");
      let complete = false;
      const started = prepared.start().then(() => {
        complete = true;
      });
      await expect(prepared.start()).rejects.toThrow("already");
      while (!complete) {
        expect((await reader.read()).done).toBe(false);
        await delay(1);
      }
      await started;
      expect(prepare).toHaveBeenCalledWith(
        expect.anything(),
        0.04,
        {
          ...(transitionMode ? { mode: transitionMode } : {}),
          curve: "equalPower",
          outgoingBassDb: -12,
          bassHandoff: true,
          headroomDb: 3,
        },
        { startFrame: expect.any(Number) },
      );
      const another = await fluent.prepareAutomix(fixture, cached);
      await another.cancel();
    },
  );

  it("cancels idempotently and rejects stale handles after stop", async () => {
    const fluent = track();
    const { result } = await run(fluent);
    const prepared = await fluent.prepareAutomix(fixture, cached);
    await prepared.cancel();
    await prepared.cancel();
    await expect(prepared.start()).rejects.toThrow("cancelled");
    const second = await fluent.prepareAutomix(fixture, cached);
    await result.stop();
    await result.done;
    await expect(second.start()).rejects.toThrow();
    await second.cancel();
  });

  it("analyzes both sources in parallel and subtracts PCM elapsed during analysis", async () => {
    const fluent = track().seekInput(2);
    const { reader } = await run(fluent);
    const resolvers: Array<(value: DjAnalysis) => void> = [];
    const analyze = vi
      .spyOn(analysis, "analyzeTrack")
      .mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const preparation = fluent.prepareAutomix(fixture, { outgoingRemainingMs: 10000 });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls.map(([url]) => url)).toEqual([fixture, fixture]);
    let bytes = 0;
    for (let i = 0; i < 4; i++) bytes += (await reader.read()).value!.byteLength;
    resolvers.forEach((resolve) => resolve(unknown));
    const prepared = await preparation;
    expect(prepared.plan.startMs).toBeGreaterThanOrEqual(2000 + (bytes / 4 / 48000) * 1000);
    expect(prepared.plan.seconds).toBeLessThanOrEqual(
      (10000 - (bytes / 4 / 48000) * 1000 - 1000) / 1000,
    );
    await prepared.cancel();
  });

  it("uses the track seek origin for beat scheduling and the incoming cue", async () => {
    const fluent = track().seekInput(2);
    const { reader } = await run(fluent);
    const schedule = vi.spyOn(PlaybackMixer.prototype, "crossfadePrepared");
    const prepared = await fluent.prepareAutomix(fixture, {
      outgoingRemainingMs: 5000,
      incomingDurationMs: 16000,
      outgoingAnalysis: grid,
      incomingAnalysis: grid,
      explicitDropMs: 5000,
    });
    expect(prepared.plan.reason).toBe("energy-entry");
    expect(prepared.plan.cueMs).toBe(1000);
    let complete = false;
    const transition = prepared.start().then(() => {
      complete = true;
    });
    while (!complete) {
      expect((await reader.read()).done).toBe(false);
      await delay(1);
    }
    await transition;
    expect(schedule.mock.calls[0]![3]).toEqual({
      startFrame: Math.round((prepared.plan.startMs - 2000) * 48),
      beatPeriodFrames: 24000,
    });
    expect(fluent.getArgs()).toContain("1");
    expect(planAutomix).toBeTypeOf("function");
  });

  it("aborts pending dual analysis on stop and releases the reservation", async () => {
    const fluent = track();
    const { result } = await run(fluent);
    const signals: AbortSignal[] = [];
    vi.spyOn(analysis, "analyzeTrack").mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signals.push(options!.signal!);
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          });
        }),
    );
    const pending = fluent.prepareAutomix(fixture, { outgoingRemainingMs: 5000 });
    const rejected = expect(pending).rejects.toThrow("stopped");
    await result.stop();
    await rejected;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("discards an unstarted preparation at outgoing EOF without auto-starting", async () => {
    const fluent = track();
    const { result, reader } = await run(fluent);
    const schedule = vi.spyOn(PlaybackMixer.prototype, "crossfadePrepared");
    const prepared = await fluent.prepareAutomix(fixture, cached);
    while (!(await reader.read()).done) {
      /* Consume only the outgoing source. */
    }
    await result.done;
    expect(schedule).not.toHaveBeenCalled();
    await expect(prepared.start()).rejects.toThrow();
    await prepared.cancel();
  });

  it("discards a ready decoder on caller abort and allows another preparation", async () => {
    const fluent = track();
    await run(fluent);
    const controller = new AbortController();
    const prepared = await fluent.prepareAutomix(fixture, { ...cached, signal: controller.signal });
    controller.abort();
    await prepared.cancel();
    await expect(prepared.start()).rejects.toThrow("cancelled");
    const replacement = await fluent.prepareAutomix(fixture, cached);
    await replacement.cancel();
  });

  it.each([false, true])(
    "rejects a stale prepared plan without changing outgoing PCM (quantized=%s)",
    async (quantized) => {
      const fluent = track();
      const { reader } = await run(fluent);
      const schedule = vi.spyOn(PlaybackMixer.prototype, "crossfadePrepared");
      const prepared = await fluent.prepareAutomix(fixture, {
        ...cached,
        outgoingRemainingMs: 5000,
        fallbackSeconds: 2,
        outgoingAnalysis: quantized ? grid : unknown,
        incomingAnalysis: quantized ? grid : unknown,
      });
      // Pass the scheduled start and leave too little time for the full overlap + tail.
      let bytes = 0;
      while (bytes < 48000 * 4 * 3) bytes += (await reader.read()).value!.byteLength;
      await expect(prepared.start()).rejects.toThrow("stale");
      expect(schedule).not.toHaveBeenCalled();
      expect((await reader.read()).done).toBe(false);
      await prepared.cancel();
      const replacement = await fluent.prepareAutomix(fixture, cached);
      await replacement.cancel();
    },
  );

  it("aborts a sibling analysis when the other fails", async () => {
    const fluent = track();
    await run(fluent);
    let siblingSignal: AbortSignal | undefined;
    const siblingAborted = vi.fn();
    vi.spyOn(analysis, "analyzeTrack")
      .mockRejectedValueOnce(new Error("analysis failed"))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            siblingSignal = options!.signal!;
            siblingSignal.addEventListener(
              "abort",
              () => {
                siblingAborted();
                reject(siblingSignal!.reason);
              },
              { once: true },
            );
          }),
      );
    await expect(fluent.prepareAutomix(fixture, { outgoingRemainingMs: 5000 })).rejects.toThrow(
      "analysis failed",
    );
    expect(siblingSignal!.aborted).toBe(true);
    expect(siblingAborted).toHaveBeenCalledOnce();
    const replacement = await fluent.prepareAutomix(fixture, cached);
    await replacement.cancel();
  });

  it.each(["caller", "stop"] as const)(
    "promptly cancels stalled decoder startup on %s and retires its late result",
    async (cause) => {
      const fluent = track();
      const { result } = await run(fluent);
      const controller = new AbortController();
      let resolveStartup!: (result: FFmpegRunResultExtended) => void;
      let startupSignal: AbortSignal | undefined;
      const create = Processor.create;
      const entered = Promise.withResolvers<void>();
      const createSpy = vi.spyOn(Processor, "create").mockImplementation((config) => {
        startupSignal = config?.options?.abortSignal;
        const processor = create(config);
        vi.spyOn(processor, "run").mockImplementation(() => {
          entered.resolve();
          return new Promise((resolve) => {
            resolveStartup = resolve;
          });
        });
        return processor;
      });
      const pending = fluent.prepareAutomix(fixture, { ...cached, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("stopped");
      await entered.promise;
      if (cause === "caller") controller.abort();
      else await result.stop();
      await rejected;
      expect(startupSignal!.aborted).toBe(true);
      const retired = Promise.withResolvers<void>();
      const stop = vi.fn(async () => {
        retired.resolve();
      });
      resolveStartup({ ...result, stop, done: Promise.resolve() });
      await retired.promise;
      expect(stop).toHaveBeenCalledWith("SIGKILL");
      createSpy.mockRestore();
      if (cause === "caller") {
        const replacement = await fluent.prepareAutomix(fixture, cached);
        await replacement.cancel();
      }
    },
  );

  it("honors an aborted caller signal without launching analysis", async () => {
    const fluent = track();
    await run(fluent);
    const analyze = vi.spyOn(analysis, "analyzeTrack");
    await expect(
      fluent.prepareAutomix(fixture, { ...cached, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(analyze).not.toHaveBeenCalled();
    const prepared = await fluent.prepareAutomix(fixture, cached);
    await prepared.cancel();
  });
});

describe.skipIf(!hasFFmpeg)("automix decision diagnostics", () => {
  it.each([false, true])(
    "delivers decisions independently of verbose=%s and logs safely",
    async (verbose) => {
      const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const fluent = track();
      const result = await fluent.run({ verbose, logger, loggerTag: "DJ" });
      runs.push(result);
      const diagnostic = vi.fn((_decision: AutomixDiagnostic) => {
        throw new Error("broken telemetry sink");
      });
      const prepared = await fluent.prepareAutomix(fixture, {
        ...cached,
        onDiagnostic: diagnostic,
      });
      expect(prepared.plan.reason).toBe("crossfade");
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "crossfade",
          fallbackReason: "unreliable-both-grids",
          outgoing: expect.objectContaining({ bpm: null, bpmConfidence: 0 }),
          incoming: expect.objectContaining({ beatPhaseMs: null, beatPhaseConfidence: 0 }),
        }),
      );
      const entries = logger.debug.mock.calls.filter((call) =>
        String(call[0]).includes("Automix decision"),
      );
      expect(entries).toHaveLength(verbose ? 1 : 0);
      if (verbose) {
        expect(entries[0]).toEqual([
          "[DJ] Automix decision",
          {
            code: "FluentStream-automix-decision",
            detail: diagnostic.mock.calls[0]![0],
          },
        ]);
        expect(JSON.stringify(entries)).not.toContain(fixture);
      }
      await prepared.cancel();
    },
  );

  it("does not let decision logger failures interrupt preparation", async () => {
    const logger = {
      debug: vi.fn((message: string) => {
        if (message.includes("Automix decision")) throw new Error("logging failed");
      }),
      info() {},
      log() {},
      warn() {},
      error() {},
    };
    const fluent = track();
    runs.push(await fluent.run({ verbose: true, logger }));
    const prepared = await fluent.prepareAutomix(fixture, cached);
    expect(prepared.plan.reason).toBe("crossfade");
    await prepared.cancel();
  });
});
