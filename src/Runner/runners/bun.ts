import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

type BunPipedProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

class BunFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private proc: BunPipedProcess;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private exitResult: { code: number | null; signal: string | null } | null = null;
  private errorCallbacks: Array<(error: Error) => void> = [];
  private processError: Error | null = null;

  constructor(proc: BunPipedProcess) {
    this.proc = proc;
    this.pid = proc.pid;

    this.stdout = proc.stdout;
    this.stderr = proc.stderr;

    let stdinClosed = false;
    proc.exited
      .then(() => {
        stdinClosed = true;
      })
      .catch(() => {
        stdinClosed = true;
      });

    this.stdin = new WritableStream({
      async write(chunk) {
        if (stdinClosed) throw new Error("FFmpeg stdin is closed");
        // Bun FileSink methods may be synchronous or asynchronous. Await both
        // so EPIPE and other native write failures reject the Web Stream write.
        await proc.stdin.write(chunk);
        if (!stdinClosed) await proc.stdin.flush();
        else throw new Error("FFmpeg stdin closed while flushing");
      },
      async close() {
        if (stdinClosed) return;
        stdinClosed = true;
        await proc.stdin.end();
      },
      async abort() {
        if (stdinClosed) return;
        stdinClosed = true;
        await proc.stdin.end();
      },
    });

    proc.exited.then(
      (code) => {
        this.notifyExit(code, proc.signalCode?.toString() ?? null);
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.processError = error;
        const callbacks = this.errorCallbacks;
        this.errorCallbacks = [];
        for (const cb of callbacks) queueMicrotask(() => cb(error));
        this.notifyExit(null, "SIGKILL");
      },
    );
  }

  kill(signal: string): void {
    this.proc.kill(signal as NodeJS.Signals);
  }

  private notifyExit(code: number | null, signal: string | null): void {
    if (this.exitResult) return;
    this.exitResult = { code, signal };
    const callbacks = this.exitCallbacks;
    this.exitCallbacks = [];
    for (const cb of callbacks) queueMicrotask(() => cb(code, signal));
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    const result = this.exitResult;
    if (result) queueMicrotask(() => cb(result.code, result.signal));
    else this.exitCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    const error = this.processError;
    if (error) queueMicrotask(() => cb(error));
    else this.errorCallbacks.push(cb);
  }
}

export class BunFFmpegRunner implements FFmpegRunner {
  spawn(ffmpegPath: string, args: string[]): FFmpegProcess {
    const proc = Bun.spawn<"pipe", "pipe", "pipe">([ffmpegPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    return new BunFFmpegProcess(proc);
  }
}
