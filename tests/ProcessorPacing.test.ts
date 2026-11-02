import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { AudioEffectController } from "../src/Audio/AudioEffectController.js";
import { AudioProcessor } from "../src/Audio/AudioProcessor.js";
import { setupOutputPipeline, splitPcmStream } from "../src/Core/processor/pipeline.js";
import type { FFmpegProcess } from "../src/Types/core.js";
import { Processor } from "../src/Core/Processor.js";

const settlePipeline = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it.each([1, 2])("splitPcmStream preserves fragmented bytes for %i channels", async (channels) => {
  const input = Uint8Array.from({ length: 1007 }, (_, i) => i % 256);
  const fragments = [
    input.subarray(0, 1),
    new Uint8Array(),
    input.subarray(1, 78),
    new Uint8Array(),
    input.subarray(78, 501),
    input.subarray(501),
  ];
  let reads = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        const next = fragments.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const split = splitPcmStream(source, 11025, channels);
  await settlePipeline();
  expect(reads).toBe(0);
  const reader = split.getReader();
  const bytes: number[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(220 * channels * 2);
    bytes.push(...value);
  }
  expect(new Uint8Array(bytes)).toEqual(input);
  expect(source.locked).toBe(false);
  reader.releaseLock();
});

it("splitPcmStream retains one raw chunk and emits one block per demand", async () => {
  let reads = 0;
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(10000));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const reader = splitPcmStream(source, 1000, 2).getReader();
  expect((await reader.read()).value?.length).toBe(80);
  await settlePipeline();
  expect(reads).toBe(1);
  expect((await reader.read()).value?.length).toBe(80);
  expect(reads).toBe(1);
  const reason = new Error("stop raw chunk");
  await reader.cancel(reason);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  expect(source.locked).toBe(false);
  reader.releaseLock();
});

it("splitPcmStream uses at least one sample frame", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.close();
    },
  });
  const reader = splitPcmStream(source, 1, 2).getReader();
  expect((await reader.read()).value?.length).toBe(4);
  expect((await reader.read()).value?.length).toBe(4);
  expect((await reader.read()).done).toBe(true);
  reader.releaseLock();
});

it("splitPcmStream propagates source errors and releases its reader", async () => {
  const error = new Error("stdout failed");
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        c.error(error);
      },
    },
    { highWaterMark: 0 },
  );
  const reader = splitPcmStream(source, 1000, 1).getReader();
  await expect(reader.read()).rejects.toBe(error);
  expect(source.locked).toBe(false);
  reader.releaseLock();
});

it.each(["resolve", "reject"])(
  "splitPcmStream ignores a late native read %s after cancel",
  async (mode) => {
    let resolve!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<ReadableStreamReadResult<Uint8Array>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const nativeReader = {
      read: vi.fn(() => pending),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const source = { getReader: () => nativeReader } as unknown as ReadableStream<Uint8Array>;
    const reader = splitPcmStream(source, 1000, 1).getReader();
    const first = reader.read();
    const second = reader.read();
    await settlePipeline();
    expect(nativeReader.read).toHaveBeenCalledTimes(1);
    const reason = new Error("cancel pending native read");
    await reader.cancel(reason);
    expect(nativeReader.cancel).toHaveBeenCalledExactlyOnceWith(reason);
    if (mode === "resolve") resolve({ done: false, value: new Uint8Array(10000) });
    else reject(new Error("late read failure"));
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await expect(second).resolves.toEqual({ done: true, value: undefined });
    await settlePipeline();
    expect(nativeReader.read).toHaveBeenCalledTimes(1);
    expect(nativeReader.releaseLock).toHaveBeenCalledTimes(1);
    reader.releaseLock();
  },
);

it("splitPcmStream propagates cancellation failure without retaining the source lock", async () => {
  const error = new Error("native cancellation failed");
  const source = new ReadableStream<Uint8Array>(
    {
      cancel() {
        throw error;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = splitPcmStream(source, 1000, 1).getReader();
  const pending = reader.read();
  await settlePipeline();
  await expect(reader.cancel("stop")).rejects.toBe(error);
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(source.locked).toBe(false);
  reader.releaseLock();
});

function outputHarness(raw: Uint8Array[], sampleRate = 8000, channels = 1) {
  let sourceReads = 0;
  const sourceCancel = vi.fn();
  const stdout = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        sourceReads++;
        const chunk = raw.shift();
        if (chunk) c.enqueue(chunk);
        else c.close();
      },
      cancel: sourceCancel,
    },
    { highWaterMark: 0 },
  );
  const process: FFmpegProcess = {
    pid: null,
    stdout,
    stdin: new WritableStream(),
    stderr: new ReadableStream(),
    kill() {},
    onExit() {},
  };
  const audio = new AudioProcessor({ sampleRate, channels });
  const internals = audio as unknown as { processPcmBufferAligned(chunk: Uint8Array): Uint8Array };
  const processed = vi.spyOn(internals, "processPcmBufferAligned");
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const onError = vi.fn();
  const onPipelineComplete = vi.fn();
  const { pipelinePromise } = setupOutputPipeline(
    process,
    audio,
    output,
    {
      sampleRate,
      channels,
      disableThrottling: true,
      verbose: false,
      loggerTag: "test",
      logger: undefined,
    },
    { onError, onPipelineComplete, hasFinished: () => false },
  );
  return {
    audio,
    processed,
    output,
    pipelinePromise,
    onError,
    onPipelineComplete,
    stdout,
    sourceCancel,
    sourceReads: () => sourceReads,
  };
}

it("setupOutputPipeline bounds huge stdout DSP work and keeps live bass effective", async () => {
  const sampleRate = 8000;
  const blockBytes = (sampleRate * 2) / 50;
  const raw = new Uint8Array(sampleRate * 2 * 30);
  const view = new DataView(raw.buffer);
  for (let i = 0; i < raw.length / 2; i++) {
    view.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 100 * i) / sampleRate)), true);
  }
  const baseline = raw.slice(0, blockBytes);
  const h = outputHarness([raw]);
  const reader = h.output.readable.getReader();
  try {
    await settlePipeline();
    expect(h.sourceReads()).toBe(1);
    expect(h.processed.mock.calls.length).toBeLessThanOrEqual(4);
    expect(h.audio.writableEnded).toBe(false);
    expect((await reader.read()).value).toEqual(baseline);
    await settlePipeline();
    const pausedCalls = h.processed.mock.calls.length;
    expect(pausedCalls).toBeLessThanOrEqual(5);
    await settlePipeline();
    expect(h.processed).toHaveBeenCalledTimes(pausedCalls);
    expect(h.audio.writableEnded).toBe(false);
    for (const [block] of h.processed.mock.calls)
      expect(block.length).toBeLessThanOrEqual(blockBytes);

    const controls = new AudioEffectController(
      h.audio,
      { logger: undefined, loggerTag: "test" },
      {
        volume: 1,
        bass: 0,
        treble: 0,
        compressor: false,
        normalize: false,
      },
    );
    controls.setBass(15);
    const rms = (bytes: Uint8Array) => {
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let sum = 0;
      for (let i = 0; i < bytes.length; i += 2) sum += samples.getInt16(i, true) ** 2;
      return Math.sqrt(sum / (bytes.length / 2));
    };
    let next = baseline;
    // Drain only fixed stage buffers plus the effect's 50 ms ramp, not the track.
    for (let i = 0; i < 12; i++) next = (await reader.read()).value!;
    expect(rms(next)).toBeGreaterThan(rms(baseline) * 1.5);
    expect(h.audio.writableEnded).toBe(false);
    expect(h.sourceReads()).toBe(1);
  } finally {
    await reader.cancel("done");
    await h.pipelinePromise;
    reader.releaseLock();
  }
  // pipeThrough's upstream cancellation settles after the final pipeTo promise.
  await settlePipeline();
  expect(h.sourceCancel).toHaveBeenCalledExactlyOnceWith("done");
  expect(h.stdout.locked).toBe(false);
});

it("setupOutputPipeline preserves fragmented PCM and AudioProcessor's padded final frame", async () => {
  const raw = Uint8Array.from({ length: 1007 }, (_, i) => i % 256);
  const h = outputHarness(
    [
      new Uint8Array(),
      raw.subarray(0, 1),
      raw.subarray(1, 530),
      new Uint8Array(),
      raw.subarray(530),
    ],
    8000,
    2,
  );
  const reader = h.output.readable.getReader();
  const bytes: number[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.push(...value);
  }
  await h.pipelinePromise;
  reader.releaseLock();
  const expected = new Uint8Array(1008);
  expected.set(raw);
  expect(new Uint8Array(bytes)).toEqual(expected);
  expect(h.audio.writableEnded).toBe(true);
  expect(h.onError).not.toHaveBeenCalled();
  expect(h.onPipelineComplete).toHaveBeenCalledTimes(1);
});

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
