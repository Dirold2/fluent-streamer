import { spawn } from "child_process";
import { Readable } from "node:stream";
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
    process.once("exit", (code, signal) => {
      this.exitResult = { code, signal };
    });
    process.once("error", (err) => {
      this.processError = err;
    });
    this.process = process;
    this.pid = process.pid ?? null;

    this.stdin = new WritableStream({
      write: (chunk) => {
        return new Promise<void>((resolve, reject) => {
          const canContinue = process.stdin!.write(chunk, (err) => {
            if (err) reject(err);
            else resolve();
          });
          if (!canContinue) {
            process.stdin!.once("drain", () => resolve());
          }
        });
      },
      close: () => {
        return new Promise<void>((resolve) => process.stdin!.end(resolve));
      },
      abort: (reason) => {
        process.stdin!.destroy(reason as Error | undefined);
      },
    });

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
      const sigName = signal ? signal.toString() : null;
      for (const cb of this.exitCallbacks) cb(code, sigName);
      this.exitCallbacks = [];
    });

    process.on("error", (err) => {
      for (const cb of this.errorCallbacks) cb(err);
      this.errorCallbacks = [];
    });
  }

  kill(signal: string): void {
    this.process.kill(signal as NodeJS.Signals);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.exitResult) {
      queueMicrotask(() => cb(this.exitResult!.code, this.exitResult!.signal));
      return;
    }
    this.exitCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    if (this.processError) {
      queueMicrotask(() => cb(this.processError!));
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
