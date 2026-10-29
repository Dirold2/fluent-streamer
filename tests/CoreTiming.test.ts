import { afterEach, describe, expect, it, vi } from "vitest";
import { Processor } from "../src/Core/Processor.js";
import { ThrottleStream } from "../src/Core/ThrottleStream.js";
import { pipeInputStreams } from "../src/Core/processor/pipeline.js";
import { StderrTracker } from "../src/Core/processor/stderr.js";
import type { FFmpegProcess } from "../src/Types/core.js";

const trackerConfig = {
  maxStderrBuffer: 10,
  enableProgressTracking: false,
  verbose: false,
  loggerTag: "test",
  logger: console,
};
const encode = (text: string) => new TextEncoder().encode(text);

afterEach(() => vi.useRealTimers());

describe("stream timing regressions", () => {
  it("does not block skip after a wall clock rollback, including the first skip", async () => {
    const processor = new Processor();
    const kill = vi.spyOn(processor, "kill").mockResolvedValue();
    const monotonic = vi.spyOn(performance, "now");
    monotonic.mockReturnValue(0);
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    await processor.skip();
    expect(kill).toHaveBeenCalledTimes(1);
    monotonic.mockReturnValue(100);
    vi.mocked(Date.now).mockReturnValue(500_000);
    await processor.skip();
    expect(kill).toHaveBeenCalledTimes(1);
    monotonic.mockReturnValue(600);
    vi.mocked(Date.now).mockReturnValue(1);
    await processor.skip();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("paces PCM independently of wall clock changes", async () => {
    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    const throttle = new ThrottleStream(192_000);
    const reader = throttle.readable.getReader();
    const writer = throttle.writable.getWriter();
    const chunk = new Uint8Array(19_200);
    let delivered = false;
    const read = reader.read().then((value) => {
      delivered = true;
      return value;
    });
    const write = writer.write(chunk);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date("2099-01-01"));
    monotonic.mockReturnValue(99);
    await vi.advanceTimersByTimeAsync(99);
    expect(delivered).toBe(false);
    monotonic.mockReturnValue(100);
    await vi.advanceTimersByTimeAsync(1);
    expect((await read).value).toBe(chunk);
    await write;
    await writer.close();
  });

  it("feeds input using backpressure without a fixed 32 kB/s throttle", async () => {
    const data = new Uint8Array(192_000);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi.fn();
    const stdin = new WritableStream<Uint8Array>({ write, close: finish });
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const onError = vi.fn();
    pipeInputStreams({ stdin } as FFmpegProcess, [{ stream: input, index: 0 }], {
      onError,
      hasFinished: () => false,
      isTerminating: () => false,
    });
    await finished;
    expect(write.mock.calls[0]![0]).toBe(data);
    expect(onError).not.toHaveBeenCalled();
  }, 1000);

  it("does not change PCM pacing when stderr detects bitrate", () => {
    const processor = new Processor();
    // Exercise the same tracker callback that processes FFmpeg stderr during a run.
    const state = processor as unknown as {
      stderrTracker: StderrTracker;
      throttledOutput: ThrottleStream;
    };
    state.throttledOutput = new ThrottleStream(192_000);
    const update = vi.spyOn(state.throttledOutput, "updateBitrate");
    state.stderrTracker.handleChunk(encode("bitrate=1536.0kbits/s\n"));
    expect(update).not.toHaveBeenCalled();
    expect(state.stderrTracker.getBitrate()).toBe(1536);
  });
});

describe("stderr diagnostics", () => {
  it("keeps the newest text after the buffer fills", () => {
    const tracker = new StderrTracker(trackerConfig);
    tracker.handleChunk(encode("0123456789"));
    tracker.handleChunk(encode("LAST ERROR"));
    expect(tracker.getBuffer()).toBe("LAST ERROR");
  });

  it("supports a disabled stderr buffer", () => {
    const tracker = new StderrTracker({ ...trackerConfig, maxStderrBuffer: 0 });
    tracker.handleChunk(encode("error"));
    expect(tracker.getBuffer()).toBe("");
  });
});
