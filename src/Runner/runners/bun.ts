import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

class BunFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private proc: ReturnType<typeof Bun.spawn>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
    this.pid = proc.pid;

    this.stdout = proc.stdout;
    this.stderr = proc.stderr;

    this.stdin = new WritableStream({
      write(chunk) {
        proc.stdin.write(chunk);
        proc.stdin.flush();
      },
      close() {
        proc.stdin.end();
      },
      abort() {
        proc.stdin.end();
      },
    });

    proc.exited
      .then((code) => {
        const signal = proc.signalCode ? proc.signalCode.toString() : null;

        for (const cb of this.exitCallbacks) {
          cb(code, signal);
        }
        this.exitCallbacks = [];
      })
      .catch(() => {
        for (const cb of this.exitCallbacks) {
          cb(null, "SIGKILL");
        }
        this.exitCallbacks = [];
      });
  }

  kill(signal: string): void {
    this.proc.kill(signal as NodeJS.Signals);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(cb);
  }
}

export class BunFFmpegRunner implements FFmpegRunner {
  spawn(ffmpegPath: string, args: string[]): FFmpegProcess {
    const proc = Bun.spawn([ffmpegPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    return new BunFFmpegProcess(proc);
  }
}
