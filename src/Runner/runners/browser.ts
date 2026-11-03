import type { FFmpegRunner, FFmpegProcess } from "../../Types/core.js";

let cachedFFmpegCtor: any = null;

async function getFFmpegCtor(): Promise<any> {
  if (cachedFFmpegCtor) return cachedFFmpegCtor;
  try {
    const mod: any = await import("@ffmpeg/ffmpeg");
    cachedFFmpegCtor = mod.FFmpeg;
    return cachedFFmpegCtor;
  } catch {
    throw new Error(
      "Browser FFmpeg runner requires @ffmpeg/ffmpeg. " +
        "Install it: npm install @ffmpeg/ffmpeg @ffmpeg/core",
    );
  }
}

class BrowserFFmpegProcess implements FFmpegProcess {
  readonly pid = null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;

  private inputChunks: Uint8Array[] = [];
  private stdinResolve!: () => void;
  private stdinDone: Promise<void>;
  private stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private ffmpegInstance: any = null;
  private exitResult: { code: number | null; signal: string | null } | null = null;
  private readonly fetchAbort = new AbortController();
  private stdinController!: WritableStreamDefaultController;

  constructor(args: string[]) {
    this.stdinDone = new Promise((r) => {
      this.stdinResolve = r;
    });

    this.stdin = new WritableStream<Uint8Array>({
      start: (c) => {
        this.stdinController = c;
      },
      write: (chunk) => {
        this.inputChunks.push(chunk.slice());
      },
      close: () => {
        this.stdinResolve();
      },
      abort: () => {
        this.kill("SIGTERM");
      },
    });

    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.stdoutController = c;
      },
    });

    this.stderr = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.stderrController = c;
      },
    });

    this._run(args).catch((err) => {
      if (this.exitResult) return;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        this.stderrController.enqueue(new TextEncoder().encode(msg + "\n"));
      } catch {
        /* closed */
      }
      this._finish(typeof err?.exitCode === "number" ? err.exitCode : 1, null);
    });
  }

  private async _run(args: string[]): Promise<void> {
    // Check if any -i pipe:N args exist — if so, wait for stdin close
    const hasPipeInput = args.some(
      (a, i) => a === "-i" && i + 1 < args.length && args[i + 1]!.startsWith("pipe:"),
    );
    if (hasPipeInput) {
      await this.stdinDone;
      if (this.exitResult) return;
    }

    const FFmpeg = await getFFmpegCtor();
    if (this.exitResult) return;

    const ffmpeg = new FFmpeg();
    this.ffmpegInstance = ffmpeg;
    if (this.exitResult) {
      this._cleanup();
      return;
    }

    // Capture stderr
    ffmpeg.on("log", ({ message }: { message: string }) => {
      try {
        this.stderrController.enqueue(new TextEncoder().encode(message + "\n"));
      } catch {
        /* closed */
      }
    });

    await ffmpeg.load();
    if (this.exitResult) {
      this._cleanup();
      return;
    }

    // Resolve inputs and build modified args
    const modifiedArgs = await this._resolveArgs(args, ffmpeg);
    if (this.exitResult) {
      this._cleanup();
      return;
    }

    // WASM execution is batch-only: expose output only after a successful exit.
    const exitCode: number = await ffmpeg.exec(modifiedArgs);
    if (this.exitResult) return;

    const outFileName = this._getOutputFileName(modifiedArgs, args);
    if (exitCode === 0 && outFileName) {
      const data: Uint8Array = await ffmpeg.readFile(outFileName);
      if (this.exitResult) return;
      this.stdoutController.enqueue(data);
    }

    // Let any trailing log messages arrive before closing stderr.
    await new Promise((r) => setTimeout(r, 10));
    this._finish(exitCode, null);
  }

  private async _resolveArgs(args: string[], ffmpeg: any): Promise<string[]> {
    const result: string[] = [];
    let stdinWritten = false;
    let pipeInputIndex = 0;
    let urlInputIndex = 0;

    for (let i = 0; i < args.length; i++) {
      if (this.exitResult) return result;
      const arg = args[i]!;

      if (arg === "-i" && i + 1 < args.length) {
        const next = args[i + 1]!;

        if (next.startsWith("pipe:")) {
          if (!stdinWritten) {
            const data = this._concatChunks(this.inputChunks);
            await ffmpeg.writeFile(`stdin_${pipeInputIndex}.raw`, data);
            this.inputChunks = [];
            stdinWritten = true;
          }
          result.push("-i", `stdin_${pipeInputIndex}.raw`);
          pipeInputIndex++;
          i++;
        } else if (next.startsWith("http://") || next.startsWith("https://")) {
          let buf: Uint8Array;
          try {
            const res = await fetch(next, { signal: this.fetchAbort.signal });
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            buf = new Uint8Array(await res.arrayBuffer());
          } catch {
            // Fetch/body errors may contain credentials or signed query parameters.
            throw new Error("Failed to fetch browser FFmpeg input");
          }
          if (this.exitResult) return result;
          const urlFile = `url_${urlInputIndex}`;
          await ffmpeg.writeFile(urlFile, buf);
          result.push("-i", urlFile);
          urlInputIndex++;
          i++;
        } else {
          result.push(arg, next);
          i++;
        }
        continue;
      }

      // Output pipe — replace with VFS file
      if (arg === "pipe:1" || arg === "pipe:1'") {
        result.push("output.raw");
        continue;
      }

      result.push(arg);
    }

    return result;
  }

  private _getOutputFileName(modifiedArgs: string[], _originalArgs: string[]): string | null {
    if (modifiedArgs.includes("output.raw")) return "output.raw";
    return null;
  }

  private _concatChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  private _closeStreams(): void {
    try {
      this.stdoutController?.close();
    } catch {
      /* already closed */
    }
    try {
      this.stderrController?.close();
    } catch {
      /* already closed */
    }
  }

  private _cleanup(): void {
    const ffmpeg = this.ffmpegInstance;
    this.ffmpegInstance = null;
    try {
      ffmpeg?.terminate();
    } catch {
      /* cleanup must not prevent terminal notification */
    }
  }

  private _finish(code: number | null, signal: string | null): void {
    if (this.exitResult) return;
    this.exitResult = { code, signal };
    this.fetchAbort.abort();
    this.stdinResolve();
    this.inputChunks = [];
    this.stdinController.error(new Error("Browser FFmpeg process exited"));
    this._cleanup();
    this._closeStreams();
    const callbacks = this.exitCallbacks;
    this.exitCallbacks = [];
    for (const cb of callbacks) this._notifyExit(cb);
  }

  private _notifyExit(cb: (code: number | null, signal: string | null) => void): void {
    const { code, signal } = this.exitResult!;
    try {
      cb(code, signal);
    } catch {
      // A subscriber must not interrupt cleanup or other exit subscribers.
    }
  }

  kill(signal: string): void {
    this._finish(null, signal);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    if (this.exitResult) this._notifyExit(cb);
    else this.exitCallbacks.push(cb);
  }
}

export class BrowserFFmpegRunner implements FFmpegRunner {
  spawn(_ffmpegPath: string, args: string[]): FFmpegProcess {
    return new BrowserFFmpegProcess(args);
  }
}
