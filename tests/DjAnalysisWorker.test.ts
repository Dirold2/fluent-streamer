import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzePcm } from "../src/Audio/analysis/DjAnalysisCore.js";

let directory: string;
let api: typeof import("../src/Audio/analysis/DjAnalysis.js");
let transport: typeof import("../src/Audio/analysis/DjAnalysisWorkerClient.js");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "fluent-dj-worker-"));
  // Exercise real separate JS workers, independent of Node's TS support or
  // Vitest's in-process transforms. Never depend on stale dist artifacts.
  await build({
    entryPoints: [
      "src/Audio/analysis/DjAnalysis.ts",
      "src/Audio/analysis/DjAnalysisCore.ts",
      "src/Audio/analysis/DjAnalysisWorker.ts",
      "src/Audio/analysis/DjAnalysisWorkerClient.ts",
    ],
    outdir: directory,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');

  api = await import(/* @vite-ignore */ pathToFileURL(join(directory, "DjAnalysis.js")).href);
  transport = await import(
    /* @vite-ignore */ pathToFileURL(join(directory, "DjAnalysisWorkerClient.js")).href
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function clicks(seconds = 30, rate = 4000): Int16Array<ArrayBuffer> {
  const samples = new Int16Array(Math.floor(seconds * rate));
  for (
    let start = Math.round(rate * 0.137);
    start < samples.length;
    start += Math.round(rate / 2)
  ) {
    for (let i = 0; i < rate * 0.012 && start + i < samples.length; i++)
      samples[start + i] = Math.round(26000 * Math.exp(-i / (rate * 0.003)) * Math.cos(i * 1.7));
  }
  return samples;
}

describe("off-thread DJ analysis (compiled workers)", () => {
  it.skipIf(spawnSync("bun", ["--version"]).status !== 0)(
    "Bun accepts the first request before the worker core import finishes",
    () => {
      const entry = pathToFileURL(join(directory, "DjAnalysis.js")).href;
      const result = spawnSync("bun", ["--eval", `
        const { analyzePcmAsync } = await import(${JSON.stringify(entry)});
        for (let i = 0; i < 3; i++) {
          const result = await analyzePcmAsync(new Int16Array(40000), 4000, { timeout: 3000 });
          if (result.analyzedDurationMs !== 10000) throw new Error("Unexpected analysis duration");
        }
      `], { encoding: "utf8", timeout: 15000 });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
    20000,
  );

  it.each([1000, 4000, 44100])(
    "exactly matches the pure core at %s Hz without detaching or changing input",
    async (rate) => {
      const input = clicks(21, rate);
      const original = input.slice();
      expect(await api.analyzePcmAsync(input, rate)).toEqual(analyzePcm(input, rate));
      expect(input).toEqual(original);
      expect(input.buffer.byteLength).toBe(original.byteLength);
    },
  );

  it("matches silence, short audio, offset views and the 90 second bound", async () => {
    const long = clicks(95);
    for (const input of [new Int16Array(), new Int16Array(40000), long.subarray(123, 1000), long]) {
      expect(await api.analyzePcmAsync(input, 4000)).toEqual(analyzePcm(input, 4000));
    }
  });

  it("converts split/odd-length little-endian bytes in the worker", async () => {
    const pcm = clicks(12);
    const bytes = new Uint8Array(pcm.byteLength + 1);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
    expect(
      await transport.runAnalysisWorker(() => ({
        format: "s16le",
        buffer: bytes.buffer,
        byteLength: bytes.length,
        sampleRate: 4000,
      })),
    ).toEqual(analyzePcm(pcm, 4000));
    expect(bytes.buffer.byteLength).toBe(0);
  });

  it("rejects pre-aborted and invalid requests", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before startup");
    controller.abort(reason);
    await expect(api.analyzePcmAsync(clicks(), 4000, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    for (const rate of [0, -1, NaN, Infinity])
      await expect(api.analyzePcmAsync(new Int16Array(), rate)).rejects.toThrow(RangeError);
    for (const timeout of [0, -1, NaN, Infinity])
      await expect(api.analyzePcmAsync(new Int16Array(), 4000, { timeout })).rejects.toThrow(
        RangeError,
      );
  });

  it("terminates an active worker on abort before rejecting", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel active worker");
    const job = transport.runAnalysisWorker(
      () => {
        // Request creation runs after the real worker has been constructed.
        setTimeout(() => controller.abort(reason), 10);
        return { format: "samples", buffer: clicks(90).buffer, sampleRate: 4000 };
      },
      { signal: controller.signal },
    );
    await expect(job).rejects.toBe(reason);
    expect((await api.analyzePcmAsync(new Int16Array(), 4000)).analyzedDurationMs).toBe(0);
  });

  it("enforces worker deadlines, including startup", async () => {
    await expect(api.analyzePcmAsync(clicks(90), 4000, { timeout: 1 })).rejects.toThrow(
      "timed out",
    );
  });

  it("isolates simultaneous jobs and keeps the event loop responsive", async () => {
    const pcm = clicks(90);
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 5);
    try {
      const [a, b] = await Promise.all([
        api.analyzePcmAsync(pcm, 4000),
        api.analyzePcmAsync(new Int16Array(40000), 4000),
      ]);
      expect(beats).toBeGreaterThan(3);
      expect(a).toEqual(analyzePcm(pcm, 4000));
      expect(b.bpm).toBeNull();
    } finally {
      clearInterval(heartbeat);
    }
  });

  it("propagates serialized worker failures and request failures", async () => {
    await expect(
      transport.runAnalysisWorker(() => ({
        format: "samples",
        buffer: new ArrayBuffer(0),
        sampleRate: 0,
      })),
    ).rejects.toThrow("sampleRate");
    const error = new Error("request preparation failed");
    await expect(
      transport.runAnalysisWorker(() => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it.each(["throw new Error('worker crashed')", "process.exit(0)"])(
    "rejects a worker error/early exit: %s",
    async (source) => {
      // An isolated compiled client points at a deliberately failing real entry.
      const faultDirectory = await mkdtemp(join(directory, "fault-"));
      await build({
        entryPoints: ["src/Audio/analysis/DjAnalysisWorkerClient.ts"],
        outdir: faultDirectory,
        bundle: true,
        platform: "node",
        format: "esm",
      });
      await writeFile(join(faultDirectory, "DjAnalysisWorker.js"), source);
      const client: typeof transport = await import(
        /* @vite-ignore */ pathToFileURL(join(faultDirectory, "DjAnalysisWorkerClient.js")).href
      );
      await expect(
        client.runAnalysisWorker(() => ({
          format: "samples",
          buffer: new ArrayBuffer(0),
          sampleRate: 4000,
        })),
      ).rejects.toThrow(source.includes("crashed") ? "worker crashed" : "exited before responding");
    },
  );
});
