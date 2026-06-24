import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

class DenoFFmpegProcess implements FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private proc: ReturnType<InstanceType<typeof Deno.Command>["spawn"]>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(proc: ReturnType<InstanceType<typeof Deno.Command>["spawn"]>) {
    this.proc = proc;
    this.pid = proc.pid;
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;

    proc.status
      .then(({ code, signal }) => {
        for (const cb of this.exitCallbacks) cb(code, signal);
        this.exitCallbacks = [];
      })
      .catch(() => {
        for (const cb of this.exitCallbacks) cb(null, null);
        this.exitCallbacks = [];
      });
  }

  kill(signal: string): void {
    this.proc.kill(signal as any);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(cb);
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
