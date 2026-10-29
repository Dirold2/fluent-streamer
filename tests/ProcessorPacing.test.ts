import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { Processor } from "../src/Core/Processor.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

it.skipIf(!hasFFmpeg).each(["intentional", "unregistered", "source error"])(
  "Processor distinguishes %s output cancellation during retirement",
  async (mode) => {
    const processor = new Processor({ autoDrainOutput: false, disableThrottling: true });
    processor.setArgs(["-f", "lavfi", "-i", "sine=sample_rate=48000", "-f", "s16le", "pipe:1"]);
    const result = await processor.run();
    const reader = result.output.getReader();
    const cancellation = new Error("intentional retirement");
    const sourceError = new Error("actual source failure");
    try {
      await reader.read();
      if (mode !== "unregistered") processor.prepareOutputCancellation(cancellation);
      if (mode === "source error") {
        const state = processor as unknown as {
          outputController: TransformStreamDefaultController<Uint8Array>;
        };
        state.outputController.error(sourceError);
      }
      await reader.cancel(cancellation).catch(() => {});
      if (mode === "intentional") {
        await result.stop("SIGKILL");
        await expect(result.done).resolves.toBeUndefined();
      } else {
        await expect(result.done).rejects.toBe(
          mode === "source error" ? sourceError : cancellation,
        );
      }
    } finally {
      reader.releaseLock();
      await result.stop("SIGKILL");
    }
  },
  10000,
);

it.skipIf(!hasFFmpeg)(
  "Processor preserves and paces real FFmpeg PCM output",
  async () => {
    const processor = new Processor({
      disableThrottling: false,
      autoDrainOutput: false,
      audioProcessorOptions: { sampleRate: 48000, channels: 2 },
    });
    processor.setArgs([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=0.4",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ]);
    const started = performance.now();
    const result = await processor.run();
    try {
      const reader = result.output.getReader();
      let bytes = 0;
      const deliveries: Array<{ audioMs: number; elapsedMs: number }> = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        deliveries.push({ audioMs: bytes / 192, elapsedMs: performance.now() - started });
      }
      reader.releaseLock();
      await result.done;
      expect(bytes).toBe(76800);
      for (const delivery of deliveries) {
        // Audio must not run ahead of wall duration, allowing scheduler/test jitter.
        expect(delivery.audioMs).toBeLessThanOrEqual(delivery.elapsedMs + 20);
      }
      expect(performance.now() - started).toBeGreaterThanOrEqual(380);
    } finally {
      await processor.kill();
    }
  },
  10000,
);
