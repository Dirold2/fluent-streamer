import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FluentStream } from "../src/index.js";
import { BassEffect } from "../src/Audio/effects/bass.js";
import { MidsEffect } from "../src/Audio/effects/mids.js";
import { TrebleEffect } from "../src/Audio/effects/treble.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const rate = 48000;
const bands = ["bass", "mids", "treble"] as const;
const frequencies = { bass: 60, mids: 1000, treble: 12000 };
const setters = { bass: "setBass", mids: "setMids", treble: "setTreble" } as const;
let directory: string;

// Retain at most one upstream chunk, consume in 20 ms blocks, and yield to FFmpeg.
// Unlike collecting the entire output, this cannot finish decoding before a setter runs.
class BoundedPCM {
  private pending = Buffer.alloc(0);
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async consume(seconds: number): Promise<number> {
    let remaining = Math.round(seconds * rate) * 4;
    let squares = 0;
    let samples = 0;
    while (remaining > 0) {
      if (this.pending.length === 0) {
        const { done, value } = await this.reader.read();
        if (done) throw new Error("Tone ended before live EQ measurements completed");
        this.pending = Buffer.from(value!);
        expect(this.pending.length % 4).toBe(0);
      }
      const length = Math.min(3840, remaining, this.pending.length);
      for (let offset = 0; offset < length; offset += 2) {
        const sample = this.pending.readInt16LE(offset);
        squares += sample * sample;
        samples++;
      }
      this.pending = this.pending.subarray(length);
      remaining -= length;
      await delay(1);
    }
    return Math.sqrt(squares / samples);
  }

  async settledRms() {
    // Far longer than the 50 ms ramp and the pipeline's bounded queued PCM.
    await this.consume(4);
    return this.consume(0.5);
  }
}

async function stopPlayback(
  result: FFmpegRunResultExtended,
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  // Finish downstream cancellation before stop() aborts the same pipe chain.
  // Starting stop first hangs ordinary playback cleanup on Node's Web Streams.
  try {
    try {
      await reader.cancel();
    } finally {
      await result.stop();
      await result.done;
    }
  } finally {
    reader.releaseLock();
  }
}

beforeAll(() => {
  if (!hasFFmpeg) return;
  directory = mkdtempSync(join(tmpdir(), "fluent-live-eq-"));
  for (const band of bands) {
    const generated = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${frequencies[band]}:sample_rate=${rate}:duration=180`,
        "-af",
        "volume=0.08",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        join(directory, `${band}.wav`),
      ],
      { timeout: 15000 },
    );
    expect(generated.status, generated.stderr?.toString()).toBe(0);
  }
}, 60000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("live EQ smoothing endpoint", () => {
  for (const [band, Effect] of [
    ["bass", BassEffect],
    ["mids", MidsEffect],
    ["treble", TrebleEffect],
  ] as const) {
    it.each([0, 10])(`${band} settles to a fresh fixed target from %i`, (initial) => {
      const target = initial === 0 ? 10 : -10;
      const changed = new Effect(initial);
      const reference = new Effect(target);
      let error = 0;
      let energy = 0;
      for (let frame = 0; frame < rate; frame++) {
        const input = 0.01 * Math.sin((2 * Math.PI * frequencies[band] * frame) / rate);
        if (frame === rate / 4) changed.set(target, 50);
        const actual = changed.processStereo(input, input, 2, rate)[0];
        const expected = reference.processStereo(input, input, 2, rate)[0];
        if (frame > rate / 2) {
          error += (actual - expected) ** 2;
          energy += expected ** 2;
        }
      }
      expect(Math.sqrt(error / energy)).toBeLessThan(1e-6);
    });
  }
});

describe.skipIf(!hasFFmpeg)("live EQ settled PCM with real FFmpeg", () => {
  for (const band of bands) {
    for (const initial of [0, 10]) {
      it(`keeps ${band} ${initial} -> ${initial === 0 ? 10 : -10} changes made during a real crossfade after handoff`, async () => {
        const target = initial === 0 ? 10 : -10;
        const input = join(directory, `${band}.wav`);
        const fluent = new FluentStream({
          enableCrossfade: true,
          autoDrainOutput: false,
          disableThrottling: true,
        })
          .input(input)
          .enableAudioProcessing()
          [setters[band]](initial)
          .audioCodec("pcm_s16le")
          .outputOptions("-vn", "-f", "s16le", "-ar", String(rate), "-ac", "2")
          .output(FluentStream.stdout);
        const result = await fluent.run();
        void result.done.catch(() => {});
        const reader = result.output.getReader();
        const pcm = new BoundedPCM(reader);
        let transition: Promise<void> | undefined;
        try {
          const before = await pcm.settledRms();
          let completed = false;
          transition = fluent.crossfade(input, 8).then(() => {
            completed = true;
          });
          void transition.catch(() => {});
          await pcm.consume(2);
          expect(completed).toBe(false);
          fluent[setters[band]](target);
          await pcm.consume(12);
          await transition;
          const after = await pcm.settledRms();
          const db = 20 * Math.log10(after / before);
          const measurement = JSON.stringify({ band, initial, target, before, after, db });
          expect(before, measurement).toBeGreaterThan(1);
          expect(after, measurement).toBeGreaterThan(1);
          if (target > initial) expect(db, measurement).toBeGreaterThan(4);
          else expect(db, measurement).toBeLessThan(-8);
        } finally {
          await stopPlayback(result, reader);
          await transition?.catch(() => {});
        }
      }, 20000);
    }
  }

  for (const mixed of [false, true]) {
    for (const band of bands) {
      for (const initial of [0, 10]) {
        it(`${mixed ? "mixed" : "ordinary"} ${band}: ${initial} -> ${initial === 0 ? 10 : -10}`, async () => {
          const target = initial === 0 ? 10 : -10;
          const fluent = new FluentStream({
            enableCrossfade: mixed,
            autoDrainOutput: false,
            disableThrottling: true,
          })
            .input(join(directory, `${band}.wav`))
            .enableAudioProcessing()
            [setters[band]](initial)
            .audioCodec("pcm_s16le")
            .outputOptions("-vn", "-f", "s16le", "-ar", String(rate), "-ac", "2")
            .output(FluentStream.stdout);
          const result = await fluent.run();
          void result.done.catch(() => {});
          const reader = result.output.getReader();
          const pcm = new BoundedPCM(reader);
          try {
            const before = await pcm.settledRms();
            fluent[setters[band]](target);
            const after = await pcm.settledRms();
            const db = 20 * Math.log10(after / before);
            const measurement = JSON.stringify({ band, initial, target, before, after, db });
            expect(before, measurement).toBeGreaterThan(1);
            expect(after, measurement).toBeGreaterThan(1);
            if (target > initial) expect(db, measurement).toBeGreaterThan(4);
            else expect(db, measurement).toBeLessThan(-8);
          } finally {
            await stopPlayback(result, reader);
          }
        }, 20000);
      }
    }
  }
});
