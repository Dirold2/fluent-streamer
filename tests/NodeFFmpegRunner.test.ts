import { describe, expect, it } from "vitest";
import { NodeFFmpegRunner } from "../src/Runner/runners/node.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("NodeFFmpegRunner", () => {
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
