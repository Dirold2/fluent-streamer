import { spawn } from "child_process";
import { Readable, Writable } from "node:stream";
import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

class NodeFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private process: ReturnType<typeof spawn>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];

  private exitResult: { code: number | null; signal: string | null } | null = null;
  private processError: Error | null = null;

  constructor(process: ReturnType<typeof spawn>) {
    this.process = process;
    this.pid = process.pid ?? null;

    // The native adapter observes error/close as well as write callbacks. A
    // callback alone does not consume Node's separately emitted EPIPE event.
    this.stdin = Writable.toWeb(process.stdin!) as unknown as WritableStream<Uint8Array>;

    const strategy = {
      highWaterMark: 64 * 1024,
      size: (chunk: Uint8Array) => chunk.byteLength,
    };
    // Node and DOM declare separate Web Stream types; the adapter returns Uint8Array chunks.
    this.stdout = Readable.toWeb(process.stdout!, {
      strategy,
    }) as unknown as ReadableStream<Uint8Array>;
    this.stderr = Readable.toWeb(process.stderr!, {
      strategy,
    }) as unknown as ReadableStream<Uint8Array>;

    process.on("exit", (code, signal) => {
      if (this.exitResult) return;
      const sigName = signal ? signal.toString() : null;
      this.exitResult = { code, signal: sigName };
      const callbacks = this.exitCallbacks;
      this.exitCallbacks = [];
      for (const cb of callbacks) queueMicrotask(() => cb(code, sigName));
    });

    process.on("error", (err) => {
      if (this.processError) return;
      this.processError = err;
      const callbacks = this.errorCallbacks;
      this.errorCallbacks = [];
      for (const cb of callbacks) queueMicrotask(() => cb(err));
    });
  }

  kill(signal: string): void {
    this.process.kill(signal as NodeJS.Signals);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    const result = this.exitResult;
    if (result) {
      queueMicrotask(() => cb(result.code, result.signal));
      return;
    }
    this.exitCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    const error = this.processError;
    if (error) {
      queueMicrotask(() => cb(error));
      return;
    }
    this.errorCallbacks.push(cb);
  }
}

export class NodeFFmpegRunner implements FFmpegRunner {
  spawn(ffmpegPath: string, args: string[]): FFmpegProcess {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new NodeFFmpegProcess(proc);
  }
}
