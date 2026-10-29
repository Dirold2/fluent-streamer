import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FluentStream } from "../src/index.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";

const fixture = "tests/320.mp3";
const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const active = new Set<FFmpegRunResultExtended>();
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  try {
    await Promise.all([...active].map((result) => result.stop()));
  } finally {
    await Promise.all(
      [...readers].map(async (reader) => {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }),
    );
    active.clear();
    readers.clear();
    for (const directory of temporaryDirectories)
      rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.clear();
  }
});

function track(sampleRate = 48000, channels = 2, input = fixture) {
  return new FluentStream({
    enableCrossfade: true,
    autoDrainOutput: false,
    disableThrottling: true,
  })
    .input(input)
    .audioCodec("pcm_s16le")
    .outputOptions("-vn", "-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels))
    .output(FluentStream.stdout);
}

async function start(fluent: FluentStream) {
  const result = await fluent.run();
  active.add(result);
  const reader = result.output.getReader();
  readers.add(reader);
  return { result, reader };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  expect(chunk.value).toBeInstanceOf(Uint8Array);
  expect(chunk.value!.byteLength).toBeGreaterThan(0);
  expect(chunk.value!.byteLength % 4).toBe(0);
  return Buffer.from(chunk.value!);
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Buffer[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    expect(value.byteLength).toBeGreaterThan(0);
    expect(value.byteLength % 4).toBe(0);
    chunks.push(Buffer.from(value));
    // Let FFmpeg startup and transition continuations run before consuming more PCM.
    await delay(2);
  }
}

// Stop pulling as soon as the transition settles, leaving the next track buffered.
async function consumeTransition(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  transition: Promise<void>,
) {
  let settled = false;
  const completion = transition.finally(() => {
    settled = true;
  });
  void completion.catch(() => {});
  const chunks: Buffer[] = [];
  while (!settled) {
    chunks.push(await readChunk(reader));
    await delay(2);
  }
  await completion;
  return Buffer.concat(chunks);
}

function seekReference(position: number, input = fixture) {
  return referencePCM(input, position);
}

const seekFadeFrames = 960; // 20 ms at 48 kHz, per phase.
const frameBytes = 4; // Stereo PCM16.
const seekFadeBytes = seekFadeFrames * frameBytes;

function expectSeekFade(actual: Buffer, reference: Buffer, phase: "out" | "in") {
  expect(actual.length).toBe(seekFadeBytes);
  const expected = Buffer.alloc(seekFadeBytes);
  for (let frame = 0; frame < seekFadeFrames; frame++) {
    const gain = phase === "out" ? 1 - (frame + 1) / seekFadeFrames : frame / (seekFadeFrames - 1);
    for (let channel = 0; channel < 2; channel++) {
      const offset = frame * frameBytes + channel * 2;
      const sample = offset < reference.length ? reference.readInt16LE(offset) : 0;
      expected.writeInt16LE(Math.round(sample * gain), offset);
    }
  }
  expect(actual).toEqual(expected);
  const silentFrame =
    phase === "out" ? actual.subarray(-frameBytes) : actual.subarray(0, frameBytes);
  expect(silentFrame).toEqual(Buffer.alloc(frameBytes));
}

function expectSeekTarget(bytes: Buffer, reference: Buffer) {
  expect(reference.length).toBeGreaterThan(seekFadeBytes);
  expect(bytes.length).toBeGreaterThanOrEqual(seekFadeBytes + reference.length);
  const boundary = bytes.length - reference.length;
  const fadeIn = bytes.subarray(boundary, boundary + seekFadeBytes);
  expectSeekFade(fadeIn, reference, "in");

  expect(bytes.subarray(boundary + seekFadeBytes)).toEqual(reference.subarray(seekFadeBytes));
  return boundary;
}

function referencePCM(input = fixture, position?: number) {
  const decoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...(position === undefined ? [] : ["-ss", String(position)]),
      "-i",
      input,
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  expect(decoded.error).toBeUndefined();
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  expect(decoded.stdout.byteLength).toBeGreaterThan(480 * 4);
  return decoded.stdout;
}

describe.skipIf(!hasFFmpeg)("live crossfade with real FFmpeg", () => {
  it("keeps one output and session completion while crossfading and draining concurrently", async () => {
    const reference = referencePCM();
    const fluent = track();
    const { result, reader } = await start(fluent);
    const output = result.output;
    const done = result.done;
    let finished = false;
    void done.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    const first = await readChunk(reader);
    expect(first).toEqual(reference.subarray(0, first.length));

    const transition = fluent.crossfade(fixture, 0.01);
    const fading = await consumeTransition(reader, transition);
    expect(fading.length).toBeGreaterThanOrEqual(480 * 4);
    expect(finished).toBe(false);
    expect(result.output).toBe(output);
    expect(result.passthrough).toBe(output);
    expect(result.done).toBe(done);
    expect(output.locked).toBe(true);

    const tail = await drain(reader);
    await expect(done).resolves.toBeUndefined();
    expect(tail.length).toBeGreaterThan(4096);
    expect(tail.subarray(-4096)).toEqual(reference.subarray(-4096));
    expect(Buffer.concat([first, fading, tail]).length).toBeGreaterThan(reference.length);
    await expect(fluent.crossfade(fixture, 0.01)).rejects.toThrow(/run with enableCrossfade/);
  }, 15000);

  it("supports two successive transitions through the same result and reader", async () => {
    const reference = referencePCM();
    const fluent = track();

    const { result, reader } = await start(fluent);
    const output = result.output;
    const done = result.done;
    await readChunk(reader);
    expect(result.crossfade).toBeTypeOf("function");

    for (let index = 0; index < 2; index++) {
      const transition =
        index === 0 ? fluent.crossfade(fixture, 0.01) : result.crossfade!(fixture, 0.01);
      const bytes = await consumeTransition(reader, transition);
      expect(bytes.length).toBeGreaterThanOrEqual(480 * 4);
      expect(result.output).toBe(output);
      expect(result.done).toBe(done);
    }

    const tail = await drain(reader);
    expect(tail.length).toBeGreaterThan(4096);
    expect(tail.subarray(-4096)).toEqual(reference.subarray(-4096));
    await expect(done).resolves.toBeUndefined();
  }, 15000);

  it("retires backpressured looped FFmpeg inputs without deadlocking successive crossfades", async () => {
    const reference = referencePCM();
    const fluent = track().inputOptions("-stream_loop", "2");
    const { result, reader } = await start(fluent);
    const output = result.output;
    const done = result.done;
    await readChunk(reader);

    // Each decoder produces three seconds of PCM. Pause between fades so the
    // retiring process still has live, backpressured stdout rather than EOF.
    for (let index = 0; index < 2; index++) {
      const bytes = await consumeTransition(reader, result.crossfade!(fixture, 0.01));
      expect(bytes.length).toBeGreaterThanOrEqual(480 * 4);
      expect(result.output).toBe(output);
      expect(result.done).toBe(done);
    }

    const tail = await drain(reader);
    expect(tail.length).toBeGreaterThan(reference.length * 2);
    expect(tail.subarray(-4096)).toEqual(reference.subarray(-4096));
    await expect(done).resolves.toBeUndefined();
  }, 10000);

  it("rejects invalid transition requests without consuming or ending the session", async () => {
    const fluent = track();
    const { result, reader } = await start(fluent);
    await readChunk(reader);
    for (const url of ["", " ", "pipe:0", "blob:fixture", "-"]) {
      await expect(fluent.crossfade(url, 0.01)).rejects.toThrow(/replayable/);
    }
    for (const seconds of [-1, NaN, Infinity, 3601]) {
      await expect(fluent.crossfade(fixture, seconds)).rejects.toThrow(/time must/);
    }
    const transition = fluent.crossfade(fixture, 0.01);
    await expect(result.crossfade!(fixture, 0.01)).rejects.toThrow(/already active/);
    await consumeTransition(reader, transition);
    expect((await drain(reader)).length).toBeGreaterThan(0);
    await expect(result.done).resolves.toBeUndefined();
  }, 15000);
});

describe.skipIf(!hasFFmpeg)("mixed live seek with real FFmpeg", () => {
  it("fades out then fades in at 0.1s while retaining the public session, output and done", async () => {
    const reference = await seekReference(0.1);
    const original = referencePCM();
    const fluent = track();
    const { result, reader } = await start(fluent);
    const { output, done } = result;
    const first = await readChunk(reader);
    const pending = fluent.seek("00:00:00.1");
    const during = await consumeTransition(
      reader,
      pending.then(() => {}),
    );
    expect(await pending).toBe(result);
    expect(result.output).toBe(output);
    expect(result.passthrough).toBe(output);
    expect(result.done).toBe(done);
    expect(output.locked).toBe(true);
    const bytes = Buffer.concat([during, await drain(reader)]);
    const boundary = expectSeekTarget(bytes, reference);
    const fadeOutStart = boundary - seekFadeBytes;
    expect(first).toEqual(original.subarray(0, first.length));
    expect(bytes.subarray(0, fadeOutStart)).toEqual(
      original.subarray(first.length, first.length + fadeOutStart),
    );
    expectSeekFade(
      bytes.subarray(fadeOutStart, boundary),
      original.subarray(first.length + fadeOutStart, first.length + boundary),
      "out",
    );
    await expect(done).resolves.toBeUndefined();
    await expect(result.seek!(0)).rejects.toThrow(/no longer active/);
  }, 15000);

  it("seeks the latest crossfaded file rather than the original input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fluent-mixed-seek-"));
    temporaryDirectories.add(directory);
    const latest = join(directory, "latest.wav");
    const generated = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=997:duration=0.4",
      "-ar",
      "48000",
      "-ac",
      "2",
      latest,
    ]);
    expect(generated.error).toBeUndefined();
    expect(generated.status, generated.stderr.toString()).toBe(0);
    const reference = await seekReference(0.1, latest);
    const fluent = track();
    const { result, reader } = await start(fluent);
    await readChunk(reader);
    await consumeTransition(reader, result.crossfade!(latest, 0.01));
    const pending = result.seek!(0.1);
    const during = await consumeTransition(
      reader,
      pending.then(() => {}),
    );
    expect(await pending).toBe(result);
    const bytes = Buffer.concat([during, await drain(reader)]);
    const boundary = expectSeekTarget(bytes, reference);
    expect(bytes.subarray(boundary, boundary + seekFadeBytes)).not.toEqual(
      reference.subarray(0, seekFadeBytes),
    );
    const args = fluent.getArgs();
    expect(args[args.indexOf("-i") + 1]).toBe(latest);
    await expect(result.done).resolves.toBeUndefined();
  }, 15000);

  it("supports repeated and backward absolute seeks without accumulating -ss", async () => {
    const reference = await seekReference(0.1);
    const fluent = track().seekInput(0.05);
    const { result, reader } = await start(fluent);
    const { output, done } = result;
    let during = Buffer.alloc(0);
    for (const position of [0.2, 0.1, 0.1]) {
      const pending = result.seek!(position);
      during = await consumeTransition(
        reader,
        pending.then(() => {}),
      );
      expect(await pending).toBe(result);
      const args = fluent.getArgs();
      expect(args.filter((arg) => arg === "-ss")).toHaveLength(1);
      expect(args[args.indexOf("-ss") + 1]).toBe(String(position));
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
      expect(result.output).toBe(output);
      expect(result.done).toBe(done);
    }
    const bytes = Buffer.concat([during, await drain(reader)]);
    expectSeekTarget(bytes, reference);
    await expect(done).resolves.toBeUndefined();
  }, 15000);

  it("preserves live result-side DSP, including karaoke and normalization, across seeks", async () => {
    const fluent = track().enableAudioProcessing();
    const { result, reader } = await start(fluent);
    result.setVolume!(0.4);
    result.setBass!(8);
    result.setMids!(-6);
    result.setTreble!(4);
    result.setCompressor!(true);
    result.setKaraoke!(true);
    result.setNormalize!(true);
    for (const position of [0.1, 0]) {
      const previous = result.audioProcessor;
      const pending = result.seek!(position);
      await consumeTransition(
        reader,
        pending.then(() => {}),
      );
      expect(await pending).toBe(result);
      const processor = result.audioProcessor!;
      expect(processor).not.toBe(previous);
      expect(processor.volume).toBe(0.4);
      expect(processor.bass).toBeCloseTo(0.4);
      expect(processor.mids).toBeCloseTo(-0.3);
      expect(processor.treble).toBeCloseTo(0.2);
      expect(processor.compressor).toBe(true);
      expect(processor.karaoke).toBe(true);
      expect(processor.normalize).toBe(true);
    }
    expect((await drain(reader)).length).toBeGreaterThan(0);
    await expect(result.done).resolves.toBeUndefined();
  }, 15000);

  it("rejects seek during crossfade and crossfade or concurrent seek during seek", async () => {
    const fluent = track();
    const { result, reader } = await start(fluent);
    const transition = fluent.crossfade(fixture, 0.01);
    await expect(result.seek!(0.1)).rejects.toThrow(/active crossfade/);
    await consumeTransition(reader, transition);
    const pending = result.seek!(0.1);
    await expect(fluent.seek(0)).rejects.toThrow(/seek.*in progress/);
    await expect(result.crossfade!(fixture, 0.01)).rejects.toThrow(/seek.*in progress/);
    await consumeTransition(
      reader,
      pending.then(() => {}),
    );
    expect(await pending).toBe(result);
    expect((await drain(reader)).length).toBeGreaterThan(0);
    await expect(result.done).resolves.toBeUndefined();
  }, 15000);

  it("stops during a pending seek without hanging cleanup or leaving an active session", async () => {
    const fluent = track().inputOptions("-stream_loop", "2");
    const { result, reader } = await start(fluent);
    await readChunk(reader);
    const pending = result.seek!(0.1);
    // No output pulls: the seek fades cannot finish before stop interrupts them.
    // Observe every promise even if stop fails, so failures cannot strand cleanup.
    const [seekOutcome, stopOutcome, doneOutcome] = await Promise.allSettled([
      pending,
      result.stop(),
      result.done,
    ]);
    active.delete(result);
    expect(seekOutcome.status).toBe("rejected");
    if (seekOutcome.status === "rejected") expect(seekOutcome.reason.message).toMatch(/stop/i);
    expect.soft(stopOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect.soft(doneOutcome).toEqual({ status: "fulfilled", value: undefined });
    expect((await reader.read()).done).toBe(true);
    await expect(result.seek!(0)).rejects.toThrow(/no longer active/);
    await expect(fluent.seek(0)).rejects.toThrow(/no active run/);
    const repeatedStop = await Promise.allSettled([result.stop()]);
    expect(repeatedStop).toEqual([{ status: "fulfilled", value: undefined }]);
  }, 10000);

  it("rejects invalid positions without interrupting or changing PCM", async () => {
    const reference = referencePCM();
    const fluent = track();
    const { result, reader } = await start(fluent);
    const first = await readChunk(reader);
    const args = fluent.getArgs();
    for (const position of [-1, NaN, Infinity, -Infinity, "", " ", "oops", "-1", "00:no:00"]) {
      await expect(result.seek!(position)).rejects.toThrow(/position/);
      expect(fluent.getArgs()).toEqual(args);
    }
    expect(Buffer.concat([first, await drain(reader)])).toEqual(reference);
    await expect(result.done).resolves.toBeUndefined();
  }, 15000);
});

describe("live crossfade validation", () => {
  it("requires an active crossfade-enabled run", async () => {
    await expect(track().crossfade(fixture, 0.01)).rejects.toThrow(/run with enableCrossfade/);
  });

  it.each([
    ["codec", () => track().audioCodec("libmp3lame"), /pcm_s16le/],
    ["format", () => track().format("mp3"), /s16le/],
    ["sample rate", () => track(44100), /-ar\/-ac/],
    ["channels", () => track(48000, 1), /-ar\/-ac/],
    ["multiple inputs", () => track().input("another.mp3"), /one \.input/],
    ["multiple outputs", () => track().output("pipe:2"), /one stdout/],
    ["complex filter", () => track().complexFilter("[0:a]anull[out]"), /no complex filters/],
    ["extra global input", () => track(), /extra global inputs/],
  ] as const)(
    "rejects an unsupported %s configuration before running FFmpeg",
    async (name, build, message) => {
      const fluent = build();
      const run = fluent.run(
        name === "extra global input" ? { extraGlobalArgs: ["-i", fixture] } : {},
      );
      // Keep cleanup safe even if a regression unexpectedly accepts the configuration.
      void run.then(
        (result) => {
          active.add(result);
        },
        () => {},
      );
      await expect(run).rejects.toThrow(message);
      expect(fluent.isDirtyState()).toBe(false);
    },
  );
});

describe.skipIf(!hasFFmpeg)("crossfade logging", () => {
  it("logs ordered lifecycle stages with durations and no source URLs", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fluent = track();
    const result = await fluent.run({ verbose: true, logger, loggerTag: "DJ" });
    active.add(result);
    const reader = result.output.getReader();
    readers.add(reader);
    await consumeTransition(reader, fluent.crossfade(fixture, 0.01));
    const entries = logger.debug.mock.calls.filter((call) =>
      String(call[0]).startsWith("[DJ] Crossfade"),
    );
    expect(entries.map((call) => call[0])).toEqual([
      "[DJ] Crossfade preparing",
      "[DJ] Crossfade mixing",
      "[DJ] Crossfade completed",
    ]);
    for (const entry of entries) {
      expect(entry[1]).toEqual(
        expect.objectContaining({
          detail: {
            durationSeconds: 0.01,
            elapsedMs: expect.any(Number),
          },
        }),
      );
      expect(JSON.stringify(entry)).not.toContain(fixture);
    }
  });

  it("respects verbose false even when a logger is supplied", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fluent = track();
    const result = await fluent.run({ logger, verbose: false });
    active.add(result);
    const reader = result.output.getReader();
    readers.add(reader);
    await consumeTransition(reader, fluent.crossfade(fixture, 0.01));
    expect(
      logger.debug.mock.calls.filter((call) => String(call[0]).includes("Crossfade")),
    ).toHaveLength(0);
  });

  it("logs interrupted transitions without swallowing the rejection", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fluent = track();
    const result = await fluent.run({ verbose: true, logger });
    active.add(result);
    const pending = fluent.crossfade(fixture, 3);
    const rejected = expect(pending).rejects.toThrow(/stop/i);
    await result.stop();
    await rejected;
    expect(logger.error).toHaveBeenCalledWith(
      "[FluentStream] Crossfade failed",
      expect.objectContaining({
        code: "FluentStream-crossfade-failed",
      }),
    );
  });
});

describe.skipIf(!hasFFmpeg)("mixtape cue offset", () => {
  it("exposes shaping options on the result and decodes from the explicit cue", async () => {
    const fluent = track();
    const { result, reader } = await start(fluent);
    await readChunk(reader);
    const output = result.output;
    const done = result.done;
    const fade = result.crossfade!(fixture, 0, {
      startTime: 0.5,
      curve: "equalPower",
      outgoingBassDb: -18,
      headroomDb: 3,
    });
    const bytes = await drain(reader);
    await fade;
    await done;
    expect(bytes.subarray(-referencePCM(fixture, 0.5).length)).toEqual(referencePCM(fixture, 0.5));
    expect(result.output).toBe(output);
    expect(result.done).toBe(done);
  });
});
