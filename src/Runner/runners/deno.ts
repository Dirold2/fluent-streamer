import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

class DenoFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private proc: ReturnType<InstanceType<typeof Deno.Command>["spawn"]>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private exitResult: { code: number | null; signal: string | null } | null = null;
  private errorCallbacks: Array<(error: Error) => void> = [];
  private processError: Error | null = null;

  constructor(proc: ReturnType<InstanceType<typeof Deno.Command>["spawn"]>) {
    this.proc = proc;
    this.pid = proc.pid;
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;

    proc.status.then(
      ({ code, signal }) => this.notifyExit(code, signal),
      (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.processError = error;
        const callbacks = this.errorCallbacks;
        this.errorCallbacks = [];
        for (const cb of callbacks) queueMicrotask(() => cb(error));
        this.notifyExit(null, null);
      },
    );
  }

  kill(signal: string): void {
    this.proc.kill(signal as any);
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

export class DenoFFmpegRunner implements FFmpegRunner {
  spawn(ffmpegPath: string, args: string[]): FFmpegProcess {
    const cmd = new Deno.Command(ffmpegPath, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const proc = cmd.spawn();
    return new DenoFFmpegProcess(proc);
  }
}
