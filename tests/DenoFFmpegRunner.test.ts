import { afterEach, expect, it, vi } from "vitest";
import { DenoFFmpegRunner } from "../src/Runner/runners/deno.js";

afterEach(() => vi.unstubAllGlobals());

function nativeProcess() {
  let resolveStatus!: (status: { code: number; signal: string | null }) => void;
  let rejectStatus!: (error: Error) => void;
  const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  const proc = {
    pid: 123,
    stdin: new WritableStream<Uint8Array>(sink),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    status: new Promise<{ code: number; signal: string | null }>((resolve, reject) => {
      resolveStatus = resolve;
      rejectStatus = reject;
    }),
    kill: vi.fn(),
  };
  const spawn = vi.fn(() => proc);
  const command = vi.fn(function () {
    return { spawn };
  });
  vi.stubGlobal("Deno", { Command: command });
  const process = new DenoFFmpegRunner().spawn("ffmpeg", ["-version"]);
  return { process, proc, sink, command, spawn, resolveStatus, rejectStatus };
}

it("retains native streams and forwards command options and kill", () => {
  const { process, proc, command, spawn } = nativeProcess();
  expect(command).toHaveBeenCalledWith("ffmpeg", {
    args: ["-version"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(process.pid).toBe(123);
  expect(process.stdin).toBe(proc.stdin);
  expect(process.stdout).toBe(proc.stdout);
  expect(process.stderr).toBe(proc.stderr);
  process.kill("SIGTERM");
  expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});

it.each([
  { code: 0, signal: null },
  { code: 9, signal: null },
  { code: 143, signal: "SIGTERM" },
])("caches status $code/$signal for late and reentrant subscribers", async (status) => {
  const { process, resolveStatus } = nativeProcess();
  const early = vi.fn();
  const reentrant = vi.fn();
  process.onExit((...args) => {
    early(...args);
    process.onExit(reentrant);
  });
  resolveStatus(status);
  await vi.waitFor(() => expect(reentrant).toHaveBeenCalledTimes(1));
  const late = vi.fn();
  process.onExit(late);
  expect(late).not.toHaveBeenCalled();
  await Promise.resolve();
  for (const cb of [early, reentrant, late]) {
    expect(cb).toHaveBeenCalledExactlyOnceWith(status.code, status.signal);
  }
});

it("reports rejected status to early and late error and exit subscribers", async () => {
  const { process, rejectStatus } = nativeProcess();
  const error = new Error("status failed");
  const earlyError = vi.fn();
  const earlyExit = vi.fn();
  process.onError?.(earlyError);
  process.onExit(earlyExit);
  rejectStatus(error);
  await vi.waitFor(() => expect(earlyExit).toHaveBeenCalledTimes(1));
  const lateError = vi.fn();
  const lateExit = vi.fn();
  process.onError?.(lateError);
  process.onExit(lateExit);
  await Promise.resolve();
  for (const cb of [earlyError, lateError]) expect(cb).toHaveBeenCalledExactlyOnceWith(error);
  for (const cb of [earlyExit, lateExit]) expect(cb).toHaveBeenCalledExactlyOnceWith(null, null);
});

it("preserves native rejected writes and writer.closed errors", async () => {
  const { process, sink } = nativeProcess();
  const error = new Error("Broken pipe");
  sink.write.mockRejectedValueOnce(error);
  const writer = process.stdin.getWriter();
  const closed = expect(writer.closed).rejects.toBe(error);
  await expect(writer.write(new Uint8Array([1]))).rejects.toBe(error);
  await closed;
  writer.releaseLock();
});

it.each(["close", "abort"] as const)("preserves native %s rejection", async (method) => {
  const { process, sink } = nativeProcess();
  const error = new Error("Broken pipe");
  sink[method].mockRejectedValueOnce(error);
  const writer = process.stdin.getWriter();
  void writer.closed.catch(() => {});
  await expect(writer[method]()).rejects.toBe(error);
  expect(sink[method]).toHaveBeenCalledTimes(1);
  writer.releaseLock();
});

it("closes native stdin once and rejects subsequent writes", async () => {
  const { process, sink } = nativeProcess();
  const writer = process.stdin.getWriter();
  await writer.close();
  await writer.closed;
  await writer.abort();
  expect(sink.close).toHaveBeenCalledTimes(1);
  expect(sink.abort).not.toHaveBeenCalled();
  await expect(writer.write(new Uint8Array([1]))).rejects.toThrow();
  writer.releaseLock();
});
