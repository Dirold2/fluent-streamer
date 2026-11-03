import { afterEach, expect, it, vi } from "vitest";
import { Processor } from "../src/Core/Processor.js";
import { FactoryInput } from "../src/Core/processor/factory.js";
import { ffmpegManager } from "../src/Runner/FFmpegRunner.js";
import type { FFmpegProcess } from "../src/Types/core.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

function mockRunner() {
  let exit!: (code: number | null, signal: string | null) => void;
  let error!: (error: Error) => void;
  let stdinController!: WritableStreamDefaultController;
  const process: FFmpegProcess = {
    pid: 123,
    stdin: new WritableStream({
      start(c) {
        stdinController = c;
      },
    }),
    stdout: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    kill: vi.fn(),
    onExit(cb) {
      exit = cb;
    },
    onError(cb) {
      error = cb;
    },
  };
  const spawn = vi.fn(() => process);
  vi.spyOn(ffmpegManager, "ensure").mockResolvedValue({ spawn });
  return {
    spawn,
    exit: (code: number | null, signal: string | null = null) => exit(code, signal),
    error: () => error(new Error("process failed")),
    closeStdin: () => stdinController.error(new Error("stdin closed")),
  };
}

it.each(["kill", "abort", "close", "destroy"] as const)(
  "%s rejects a pending open promptly and cancels a late stream",
  async (mode) => {
    const runner = mockRunner();
    const abort = new AbortController();
    let resolve!: (stream: ReadableStream<Uint8Array>) => void;
    let signal!: AbortSignal;
    const open = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<ReadableStream<Uint8Array>>((yes) => {
        resolve = yes;
      });
    });
    const processor = new Processor({ abortSignal: abort.signal });
    processor.setInputSources([{ type: "factory", source: { open }, index: 0 }]);
    expect(open).not.toHaveBeenCalled();
    const running = processor.run();
    const rejection = expect(running).rejects.toThrow(/factory input|before spawn/);
    await tick();
    if (mode === "abort") abort.abort();
    else if (mode === "kill") await processor.kill();
    else if (mode === "destroy") processor.destroy();
    else await processor.close().catch(() => {});
    await rejection;
    expect(signal.aborted).toBe(true);
    const cancel = vi.fn();
    resolve(new ReadableStream({ cancel }));
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
    expect(runner.spawn).not.toHaveBeenCalled();
  },
);

it("opens independently on replay and does not retain a factory after replacing sources", async () => {
  let runner = mockRunner();
  const signals: AbortSignal[] = [];
  const open = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new ReadableStream<Uint8Array>();
  });
  const processor = new Processor({ ffmpegPath: "/mock/ffmpeg", autoDrainOutput: true });
  processor.setInputSources([{ type: "factory", source: { open }, index: 0 }]);
  processor.setArgs(["-i", "pipe:0"]);
  expect(processor.getFullArgs().filter((arg) => arg === "pipe:0")).toHaveLength(1);
  for (let i = 0; i < 2; i++) {
    runner = mockRunner();
    const result = await processor.run();
    runner.exit(0);
    await result.done;
    expect(signals[i]!.aborted).toBe(true);
  }
  expect(signals[0]).not.toBe(signals[1]);
  processor.setInputSources([]);
  runner = mockRunner();
  const result = await processor.run();
  runner.exit(0);
  await result.done;
  expect(open).toHaveBeenCalledTimes(2);
});

it.each(["exit", "error", "stdin"])("releases factory input on %s", async (mode) => {
  const runner = mockRunner();
  const order: string[] = [];
  let source!: ReadableStream<Uint8Array>;
  const processor = new Processor({ ffmpegPath: "/mock/ffmpeg" });
  processor.setInputSources([
    {
      type: "factory",
      index: 0,
      source: {
        open(signal) {
          signal.addEventListener("abort", () => order.push("abort"));
          source = new ReadableStream({
            cancel() {
              order.push("cancel");
            },
          });
          return source;
        },
      },
    },
  ]);
  const result = await processor.run();
  const done = result.done.catch(() => {});
  if (mode === "exit") runner.exit(0);
  else if (mode === "error") runner.error();
  else runner.closeStdin();
  await done;
  await tick();
  expect(order).toEqual(["abort", "cancel"]);
  expect(source.locked).toBe(false);
});

it("sanitizes factory open and read failures", async () => {
  const processor = new Processor();
  processor.setInputSources([
    {
      type: "factory",
      index: 0,
      source: {
        open() {
          throw new Error("secret-token");
        },
      },
    },
  ]);
  await expect(processor.run()).rejects.toThrow("Unable to open FFmpeg factory input");
  const input = new FactoryInput();
  await input.open({
    open: () =>
      new ReadableStream({
        pull() {
          throw new Error("secret-token");
        },
      }),
  });
  await expect(input.pipeTo(new WritableStream())).rejects.toThrow(
    "FFmpeg factory input transfer failed",
  );
});

it("closes stdin and releases locks at factory EOF", async () => {
  const input = new FactoryInput();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  const close = vi.fn();
  const stdin = new WritableStream<Uint8Array>({ close });
  await input.open({ open: () => source });
  await input.pipeTo(stdin);
  expect(close).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
  expect(stdin.locked).toBe(false);
  expect(input.signal.aborted).toBe(true);
});

it("awaits stdin writes before requesting another source chunk", async () => {
  const input = new FactoryInput();
  let reads = 0;
  let unblock!: () => void;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        reads++;
        c.enqueue(new Uint8Array([1]));
      },
    },
    { highWaterMark: 0 },
  );
  await input.open({ open: () => source });
  const piping = input
    .pipeTo(
      new WritableStream({
        write() {
          return new Promise<void>((resolve) => {
            unblock = resolve;
          });
        },
      }),
    )
    .catch(() => {});
  await tick();
  expect(reads).toBe(1);
  input.dispose();
  unblock();
  await piping;
  expect(source.locked).toBe(false);
});

it("rejects concurrent startup/reset and multiple pipe inputs without opening", async () => {
  const processor = new Processor();
  processor.setInputSources([
    {
      type: "factory",
      index: 0,
      source: {
        open: () => new Promise<ReadableStream<Uint8Array>>(() => {}),
      },
    },
  ]);
  const running = processor.run();
  const rejection = expect(running).rejects.toThrow();
  await expect(processor.run()).rejects.toThrow("already running");
  expect(() => processor.reset()).toThrow("Cannot reset");
  await processor.kill();
  await rejection;
  const open = vi.fn(() => new ReadableStream<Uint8Array>());
  processor.setInputSources([{ type: "factory", index: 0, source: { open } }]);
  processor.setInputStreams([{ index: 1, stream: new ReadableStream() }]);
  await expect(processor.run()).rejects.toThrow("Multiple stream inputs");
  expect(open).not.toHaveBeenCalled();
});
