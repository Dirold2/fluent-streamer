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
  private _killCalled = false;

  constructor(args: string[]) {
    this.stdinDone = new Promise((r) => {
      this.stdinResolve = r;
    });

    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.inputChunks.push(chunk.slice());
      },
      close: () => {
        this.stdinResolve();
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
      const msg = err instanceof Error ? err.message : String(err);
      try {
        this.stderrController.enqueue(new TextEncoder().encode(msg + "\n"));
      } catch {
        /* closed */
      }
      this._closeStreams();
      for (const cb of this.exitCallbacks) cb(1, null);
      this.exitCallbacks = [];
    });
  }

  private async _run(args: string[]): Promise<void> {
    // Check if any -i pipe:N args exist — if so, wait for stdin close
    const hasPipeInput = args.some(
      (a, i) => a === "-i" && i + 1 < args.length && args[i + 1]!.startsWith("pipe:"),
    );
    if (hasPipeInput) {
      await this.stdinDone;
      if (this._killCalled) return;
    }

    const FFmpeg = await getFFmpegCtor();

    const ffmpeg = new FFmpeg();
    this.ffmpegInstance = ffmpeg;
    if (this._killCalled) {
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
    if (this._killCalled) {
      this._cleanup();
      return;
    }

    // Resolve inputs and build modified args
    const modifiedArgs = await this._resolveArgs(args, ffmpeg);
    if (this._killCalled) {
      this._cleanup();
      return;
    }

    // Execute FFmpeg
    let exitCode = 0;
    try {
      await ffmpeg.exec(modifiedArgs);
    } catch (err) {
      // Wait for any remaining log callbacks to fire
      await new Promise((r) => setTimeout(r, 10));
      this._closeStreams();
      exitCode = (err as any)?.exitCode ?? 1;
      for (const cb of this.exitCallbacks) cb(exitCode, null);
      this.exitCallbacks = [];
      return;
    }

    // Read output file and pump to stdout
    const outFileName = this._getOutputFileName(modifiedArgs, args);
    if (outFileName) {
      try {
        const data: Uint8Array = await ffmpeg.readFile(outFileName);
        this.stdoutController.enqueue(data);
      } catch {
        // Output file not found
      }
    }
    this.stdoutController.close();

    // Let any trailing log messages arrive
    await new Promise((r) => setTimeout(r, 10));
    this.stderrController.close();

    for (const cb of this.exitCallbacks) cb(exitCode, null);
    this.exitCallbacks = [];
  }

  private async _resolveArgs(args: string[], ffmpeg: any): Promise<string[]> {
    const result: string[] = [];
    let stdinWritten = false;
    let pipeInputIndex = 0;
    let urlInputIndex = 0;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;

      if (arg === "-i" && i + 1 < args.length) {
        const next = args[i + 1]!;

        if (next.startsWith("pipe:")) {
          if (!stdinWritten) {
            const data = this._concatChunks(this.inputChunks);
            await ffmpeg.writeFile(`stdin_${pipeInputIndex}.raw`, data);
            stdinWritten = true;
          }
          result.push("-i", `stdin_${pipeInputIndex}.raw`);
          pipeInputIndex++;
          i++;
        } else if (next.startsWith("http://") || next.startsWith("https://")) {
          const res = await fetch(next);
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching "${next}"`);
          const buf = new Uint8Array(await res.arrayBuffer());
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
    this.ffmpegInstance?.terminate();
    this.ffmpegInstance = null;
  }

  kill(signal: string): void {
    this._killCalled = true;
    this._cleanup();
    for (const cb of this.exitCallbacks) cb(null, signal);
    this.exitCallbacks = [];
    this._closeStreams();
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCallbacks.push(cb);
  }
}

export class BrowserFFmpegRunner implements FFmpegRunner {
  spawn(_ffmpegPath: string, args: string[]): FFmpegProcess {
    return new BrowserFFmpegProcess(args);
  }
}
