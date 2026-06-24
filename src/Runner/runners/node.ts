import { spawn } from "child_process";
import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

class NodeFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private process: ReturnType<typeof spawn>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(process: ReturnType<typeof spawn>) {
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

    this.stdout = new ReadableStream({
      start(controller) {
        process.stdout!.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        process.stdout!.on("end", () => controller.close());
        process.stdout!.on("error", (err) => controller.error(err));
      },
      cancel() {
        process.stdout!.destroy();
      },
    });

    this.stderr = new ReadableStream({
      start(controller) {
        process.stderr!.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        process.stderr!.on("end", () => controller.close());
        process.stderr!.on("error", (err) => controller.error(err));
      },
      cancel() {
        process.stderr!.destroy();
      },
    });

    process.on("exit", (code, signal) => {
      const sigName = signal ? signal.toString() : null;
      for (const cb of this.exitCallbacks) cb(code, sigName);
      this.exitCallbacks = [];
    });

    process.on("error", (_err) => {
      for (const cb of this.exitCallbacks) cb(null, null);
      this.exitCallbacks = [];
    });
  }

  kill(signal: string): void {
    this.process.kill(signal as NodeJS.Signals);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(cb);
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
