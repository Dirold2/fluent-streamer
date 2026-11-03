import { afterEach, expect, it, vi } from "vitest";
import { BunFFmpegRunner } from "../src/Runner/runners/bun.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sinkProcess() {
  let exit!: (code: number) => void;
  let rejectExit!: (error: Error) => void;
  const sink = {
    write: vi.fn((): number | Promise<number> => 1),
    flush: vi.fn((): number | Promise<number> => 1),
    end: vi.fn((): number | Promise<number> => 0),
  };
  const proc = {
    stdin: sink,
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    pid: 1,
    signalCode: null as string | null,
    exited: new Promise<number>((resolve, reject) => {
      exit = resolve;
      rejectExit = reject;
    }),
    kill: vi.fn(),
  };
  if (typeof Bun === "undefined") vi.stubGlobal("Bun", { spawn: () => proc });
  else
    vi.spyOn(Bun, "spawn").mockImplementation(
      () => proc as unknown as ReturnType<typeof Bun.spawn>,
    );
  const process = new BunFFmpegRunner().spawn("ffmpeg", []);
  return { sink, exit, rejectExit, proc, process, writer: process.stdin.getWriter() };
}

it.each([0, 7])("caches exit %s for late and reentrant subscribers", async (code) => {
  const { process, exit, proc, writer } = sinkProcess();
  proc.signalCode = code === 7 ? "SIGTERM" : null;
  const early = vi.fn();
  const reentrant = vi.fn();
  process.onExit((...args) => {
    early(...args);
    process.onExit(reentrant);
  });
  exit(code);
  await vi.waitFor(() => expect(reentrant).toHaveBeenCalledTimes(1));
  const late = vi.fn();
  process.onExit(late);
  expect(late).not.toHaveBeenCalled();
  await Promise.resolve();
  for (const callback of [early, reentrant, late]) {
    expect(callback).toHaveBeenCalledExactlyOnceWith(code, proc.signalCode);
  }
  await writer.close();
  writer.releaseLock();
});

it("reports and replays rejected exited without duplicate exit notification", async () => {
  const { process, rejectExit, writer } = sinkProcess();
  const error = new Error("status failed");
  const earlyError = vi.fn();
  const earlyExit = vi.fn();
  process.onError?.(earlyError);
  process.onExit(earlyExit);
  rejectExit(error);
  await vi.waitFor(() => expect(earlyExit).toHaveBeenCalledTimes(1));
  const lateError = vi.fn();
  const lateExit = vi.fn();
  process.onError?.(lateError);
  process.onExit(lateExit);
  await Promise.resolve();
  for (const cb of [earlyError, lateError]) expect(cb).toHaveBeenCalledExactlyOnceWith(error);
  for (const cb of [earlyExit, lateExit])
    expect(cb).toHaveBeenCalledExactlyOnceWith(null, "SIGKILL");
  await writer.close();
  writer.releaseLock();
});

it("rejects writes after exit without touching the native sink", async () => {
  const { sink, writer, exit } = sinkProcess();
  exit(0);
  await Promise.resolve();
  const closed = expect(writer.closed).rejects.toThrow("stdin is closed");
  await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("stdin is closed");
  await closed;
  expect(sink.write).not.toHaveBeenCalled();
  writer.releaseLock();
});

it.each(["close", "abort"] as const)("ends stdin only once on %s", async (method) => {
  const { sink, writer } = sinkProcess();
  await writer[method]();
  await writer.abort();
  expect(sink.end).toHaveBeenCalledTimes(1);
  writer.releaseLock();
});

it.each(["write", "flush", "end"] as const)("forwards synchronous %s failures", async (method) => {
  const { sink, writer } = sinkProcess();
  const error = new Error("EPIPE");
  sink[method].mockImplementation(() => {
    throw error;
  });
  const closed = expect(writer.closed).rejects.toBe(error);
  const operation = method === "end" ? writer.close() : writer.write(new Uint8Array([1]));
  await expect(operation).rejects.toBe(error);
  await closed;
  writer.releaseLock();
});

it("does not flush or end an exited process after an in-flight write", async () => {
  const { sink, writer, exit } = sinkProcess();
  let written!: (value: number) => void;
  sink.write.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        written = resolve;
      }),
  );
  const closed = expect(writer.closed).rejects.toThrow("stdin closed while flushing");
  const write = expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
    "stdin closed while flushing",
  );
  await vi.waitFor(() => expect(sink.write).toHaveBeenCalledTimes(1));
  exit(0);
  await Promise.resolve();
  written(1);
  await write;
  await closed;
  expect(sink.flush).not.toHaveBeenCalled();
  expect(sink.end).not.toHaveBeenCalled();
  writer.releaseLock();
});

it.each(["write", "flush"] as const)(
  "forwards asynchronous %s errors to write and closed",
  async (method) => {
    const { sink, writer } = sinkProcess();
    const error = new Error("EPIPE");
    sink[method].mockImplementation(() => Promise.reject(error));
    const closed = expect(writer.closed).rejects.toBe(error);
    await expect(writer.write(new Uint8Array([1]))).rejects.toBe(error);
    await closed;
    writer.releaseLock();
  },
);

it("waits for write before flush and for flush before the next write", async () => {
  const { sink, writer } = sinkProcess();
  let written!: (value: number) => void;
  let flushed!: (value: number) => void;
  sink.write.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        written = resolve;
      }),
  );
  sink.flush.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        flushed = resolve;
      }),
  );
  const first = writer.write(new Uint8Array([1]));
  const second = writer.write(new Uint8Array([2]));
  await vi.waitFor(() => expect(sink.write).toHaveBeenCalledTimes(1));
  expect(sink.flush).not.toHaveBeenCalled();
  written(1);
  await vi.waitFor(() => expect(sink.flush).toHaveBeenCalledTimes(1));
  expect(sink.write).toHaveBeenCalledTimes(1);
  flushed(1);
  await Promise.all([first, second]);
  await writer.close();
  writer.releaseLock();
});

it.each(["close", "abort"] as const)("observes asynchronous end failure on %s", async (method) => {
  const { sink, writer } = sinkProcess();
  const error = new Error("EPIPE");
  sink.end.mockImplementation(() => Promise.reject(error));
  void writer.closed.catch(() => {});
  await expect(writer[method]()).rejects.toBe(error);
  expect(sink.end).toHaveBeenCalledTimes(1);
  writer.releaseLock();
});

it.each(["close", "abort"] as const)(
  "does not end stdin again on %s after process exit",
  async (method) => {
    const { sink, writer, exit } = sinkProcess();
    exit(0);
    await Promise.resolve();
    await writer[method]();
    expect(sink.end).not.toHaveBeenCalled();
    writer.releaseLock();
  },
);
