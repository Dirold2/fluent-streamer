import { describe, expect, it } from "vitest";
import { analyzePcm, analyzePcmAsync } from "../src/Audio/analysis/DjAnalysis.js";
import { runAnalysisWorker } from "../src/Audio/analysis/DjAnalysisWorkerClient.js";

function clicks(seconds: number): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(seconds * 4000);
  for (let i = 0; i < pcm.length; i += 2000) pcm[i] = 25000;
  return pcm;
}

describe("real runtime DJ workers", () => {
  it("matches synchronous analysis without modifying the input", async () => {
    const pcm = clicks(21);
    const copy = pcm.slice();
    expect(await analyzePcmAsync(pcm, 4000)).toEqual(analyzePcm(pcm, 4000));
    expect(pcm).toEqual(copy);
    expect(pcm.buffer.byteLength).toBe(copy.buffer.byteLength);
  });

  it("isolates parallel jobs", async () => {
    const pcm = clicks(21);
    const [first, second] = await Promise.all([
      analyzePcmAsync(pcm, 4000),
      analyzePcmAsync(new Int16Array(40000), 4000),
    ]);
    expect(first).toEqual(analyzePcm(pcm, 4000));
    expect(second.bpm).toBeNull();
  });

  it("handles cancellation before and during a job and accepts a subsequent job", async () => {
    const pre = new AbortController();
    const preReason = new Error("pre-aborted");
    pre.abort(preReason);
    await expect(analyzePcmAsync(clicks(1), 4000, { signal: pre.signal })).rejects.toBe(preReason);
    const active = new AbortController();
    const reason = new Error("active abort");
    const job = runAnalysisWorker(
      () => {
        setTimeout(() => active.abort(reason), 10);
        return { format: "samples", buffer: clicks(90).buffer, sampleRate: 4000 };
      },
      { signal: active.signal },
    );
    await expect(job).rejects.toBe(reason);
    expect((await analyzePcmAsync(new Int16Array(), 4000)).analyzedDurationMs).toBe(0);
  });

  it("enforces deadlines and propagates validation and worker errors", async () => {
    await expect(analyzePcmAsync(clicks(90), 4000, { timeout: 1 })).rejects.toThrow("timed out");
    await expect(analyzePcmAsync(clicks(1), 4000, { timeout: 0 })).rejects.toThrow(RangeError);
    await expect(
      runAnalysisWorker(() => ({
        format: "samples",
        buffer: new ArrayBuffer(0),
        sampleRate: 0,
      })),
    ).rejects.toThrow("sampleRate");
  });
});
