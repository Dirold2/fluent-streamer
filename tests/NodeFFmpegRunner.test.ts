import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NodeFFmpegRunner } from "../src/Runner/runners/node.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("NodeFFmpegRunner", () => {
  it.each(["stdout", "stderr"] as const)(
    "applies byte backpressure to %s and resumes without data loss",
    async (output) => {
      const total = 8 * 1024 * 1024;
      const ffmpegProcess = new NodeFFmpegRunner().spawn(globalThis.process.execPath, [
        "-e",
        `process.${output}.end(Buffer.alloc(${total}, 42))`,
      ]);
      const child = (ffmpegProcess as unknown as { process: ChildProcessWithoutNullStreams }).process;
      const source = child[output];
      const reader = ffmpegProcess[output].getReader();
      try {
        await vi.waitFor(() => {
          expect(source.readableLength).toBeGreaterThan(0);
          expect(source.readableFlowing).toBe(false);
        });
        expect(source.readableLength).toBeLessThanOrEqual(source.readableHighWaterMark + 64 * 1024);
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          expect(value.every((byte) => byte === 42)).toBe(true);
          received += value.byteLength;
        }
        expect(received).toBe(total);
      } finally {
        await reader.cancel();
        child.kill();
      }
    },
  );

  it.each(["stdout", "stderr"] as const)("destroys %s on cancellation", async (output) => {
    const ffmpegProcess = new NodeFFmpegRunner().spawn(globalThis.process.execPath, [
      "-e", "setInterval(() => {}, 1000)",
    ]);
    const child = (ffmpegProcess as unknown as { process: ChildProcessWithoutNullStreams }).process;
    try {
      await ffmpegProcess[output].cancel(new Error("cancelled"));
      expect(child[output].destroyed).toBe(true);
    } finally {
      child.kill();
    }
  });

  it.each(["stdout", "stderr"] as const)("forwards %s errors", async (output) => {
    const ffmpegProcess = new NodeFFmpegRunner().spawn(globalThis.process.execPath, [
      "-e", "setInterval(() => {}, 1000)",
    ]);
    const child = (ffmpegProcess as unknown as { process: ChildProcessWithoutNullStreams }).process;
    try {
      const error = new Error("output failed");
      const result = expect(ffmpegProcess[output].getReader().read()).rejects.toBe(error);
      child[output].destroy(error);
      await result;
    } finally {
      child.kill();
    }
  });
  it("replays an exit that occurs before subscription", async () => {
    const ffmpegProcess = new NodeFFmpegRunner().spawn(globalThis.process.execPath, ["-e", "process.exit(0)"]);

    await delay(50);

    await expect(
      new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        ffmpegProcess.onExit((code, signal) => resolve({ code, signal }));
      }),
    ).resolves.toEqual({ code: 0, signal: null });
  });

  it("replays a spawn error that occurs before subscription", async () => {
    const ffmpegProcess = new NodeFFmpegRunner().spawn("/definitely-not-an-executable", []);

    await delay(0);

    const error = await new Promise<Error>((resolve) => {
      ffmpegProcess.onError?.(resolve);
    });

    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
