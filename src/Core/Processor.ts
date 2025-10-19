import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import type {
  FFmpegRunResult,
  Logger,
  FFmpegProgress,
} from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";

/**
 * Processor launches FFmpeg processes and manages their IO streams,
 * progress tracking, timeouts, and lifecycle events for robust orchestration.
 *
 * @example
 * ```ts
 * const worker = new Processor({ ffmpegPath: "/usr/bin/ffmpeg", loggerTag: "my-tag" });
 * worker.setArgs(["-i", "input.wav", "output.mp3"]);
 * const { output, done, stop } = worker.run();
 *
 * output.pipe(fs.createWriteStream("output.mp3"));
 *
 * done.then(() => {
 *   console.log("Processing completed!");
 * }).catch(console.error);
 *
 * // To stop early:
 * // stop();
 * ```
 */
export class Processor extends EventEmitter {
  private process: Subprocess | null = null;
  private outputStream: PassThrough | null = null;
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private extraOutputs: Array<{ stream: Writable; index: number }> = [];
  private stderrBuffer = "";
  private isTerminating = false;
  private hasFinished = false;
  private timeoutHandle?: NodeJS.Timeout;
  private progress: Partial<FFmpegProgress> = {};

  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private readonly donePromise: Promise<void>;

  private readonly config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
  };

  private args: string[] = [];
  private extraGlobalArgs: string[] = [];

  /**
   * Returns the current child process id (pid) or null if the process is not running.
   *
   * @example
   * const pid = worker.pid;
   */
  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * Creates a new ProcessorWorker.
   *
   * @param options ProcessorOptions (all are optional)
   *
   * @example
   * const worker = new ProcessorWorker({ ffmpegPath: "/usr/bin/ffmpeg" });
   */
  constructor(options: ProcessorOptions = {}) {
    super();
    this.config = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      failFast: options.failFast ?? false,
      extraGlobalArgs: options.extraGlobalArgs ?? [],
      loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
      timeout: options.timeout ?? 0,
      maxStderrBuffer: options.maxStderrBuffer ?? 1024 * 1024,
      enableProgressTracking: options.enableProgressTracking ?? false,
      logger: (options.logger as Logger) ?? console,
      suppressPrematureCloseWarning:
        options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
    };
    this.extraGlobalArgs = this.config.extraGlobalArgs;

    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });

    this._handleAbortSignal();
  }

  /**
   * Sets the main arguments for ffmpeg.
   * This will override existing arguments.
   *
   * @param args Array of string arguments (e.g., ["-i", "input.wav", "output.mp3"])
   * @returns this
   *
   * @example
   * worker.setArgs(["-i", "input.wav", "output.mp3"]);
   */
  setArgs(args: string[]): this {
    this.args = [...args];
    return this;
  }

  /**
   * Returns a copy of the set ffmpeg arguments (excluding global args).
   *
   * @returns string[]
   *
   * @example
   * console.log(worker.getArgs());
   */
  getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Sets input streams to be used as ffmpeg inputs.
   *
   * @param streams Array of objects with .stream (Readable) and .index (input index)
   * @returns this
   *
   * @example
   * worker.setInputStreams([{ stream: fs.createReadStream("foo.wav"), index: 0 }]);
   */
  setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = streams;
    return this;
  }

  /**
   * Returns the writable ffmpeg input stream (stdin),
   * or undefined if process isn't running, or no stdin.
   *
   * @returns NodeJS.WritableStream | undefined
   *
   * @example
   * // After .run()
   * const stdin = worker.getInputStream();
   */
  getInputStream(): NodeJS.WritableStream | undefined {
    return this.process?.stdin || undefined;
  }

  /**
   * Sets extra output streams (e.g., for ffmpeg pipe:2/3...).
   *
   * @param streams Array of objects with .stream (Writable) and .index (output index)
   * @returns this
   *
   * @example
   * worker.setExtraOutputStreams([{ stream: someWritable, index: 2 }]);
   */
  setExtraOutputStreams(
    streams: Array<{ stream: Writable; index: number }>,
  ): this {
    this.extraOutputs = streams;
    return this;
  }

  /**
   * Sets extra global ffmpeg arguments (e.g., ["-hide_banner"]).
   *
   * @param args Array of string arguments
   * @returns this
   *
   * @example
   * worker.setExtraGlobalArgs(["-hide_banner"]);
   */
  setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = [...args];
    return this;
  }

  /**
   * Returns the full ffmpeg argument list including global args and main args.
   *
   * @returns string[]
   *
   * @example
   * console.log(worker.getFullArgs());
   */
  getFullArgs(): string[] {
    return [...this.extraGlobalArgs, ...this.args];
  }

  /**
   * Runs the ffmpeg process according to current arguments and options.
   * Returns handles to output stream, a promise for completion, and stop function.
   *
   * @returns {FFmpegRunResult}
   *
   * @example
   * const { output, done, stop } = worker.run();
   * output.on("data", chunk => /* do something *\/);
   * done.then(() => console.log("Done!"));
   * // stop(); // to cancel early
   */
  run(): FFmpegRunResult {
    if (this.process) throw new Error("FFmpeg process is already running");
    this.outputStream = new PassThrough();

    const fullArgs = this.getFullArgs();
    const fullCmd = `${this.config.ffmpegPath} ${fullArgs.join(" ")}`;

    this.emit("start", fullCmd);
    this.config.logger.debug?.(
      `[${this.config.loggerTag}] Starting: ${fullCmd}`,
    );

    this.process = execa(this.config.ffmpegPath, fullArgs, {
      reject: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    this.config.logger.debug?.(
      `[${this.config.loggerTag}] PID: ${this.process.pid ?? null}`,
    );

    this._handleTimeout();
    this._bindInputStream();
    this._bindOutputStreams();
    this._bindProcessEvents();

    this.process.once("spawn", () => {
      this.emit("spawn", { pid: this.process?.pid ?? null });
    });

    return {
      output: this.outputStream,
      done: this.donePromise,
      stop: () => this.kill(),
    };
  }

  /**
   * Kills the running ffmpeg process (if any) with the specified signal.
   *
   * @param signal NodeJS.Signals (default: "SIGTERM")
   *
   * @example
   * worker.kill(); // Sends SIGTERM
   * worker.kill("SIGKILL");
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Killing process with signal ${signal}`,
      );
      this.process.kill(signal);
    }
  }

  /**
   * Builds an ffmpeg 'acrossfade' filter string with the given options.
   * Returns { filter, outputLabel }.
   *
   * @param opts Configuration for acrossfade (duration, curves, nb_samples, outputLabel, etc.)
   * @returns Object with 'filter' (string) and optional 'outputLabel' (string)
   *
   * @example
   * const result = ProcessorWorker.buildAcrossfadeFilter({ duration: 2.5, curve1: 'exp', outputLabel: "end" });
   * // result.filter -> 'acrossfade=d=2.5:c1=exp:c2=tri[end]'
   */
  static buildAcrossfadeFilter(
    opts: {
      inputs?: number;
      nb_samples?: number;
      duration?: number | string;
      overlap?: boolean;
      curve1?: string;
      curve2?: string;
      inputLabels?: string[];
      outputLabel?: string;
    } = {},
  ): { filter: string; outputLabel?: string } {
    let str = "acrossfade";
    let hasParam = false;
    const add = (key: string, val: string | number | undefined) => {
      if (val === undefined || val === "") return;
      str += (hasParam ? ":" : "=") + key + "=" + val;
      hasParam = true;
    };
    add("d", opts.duration);
    add("c1", opts.curve1 ?? "tri");
    add("c2", opts.curve2 ?? "tri");
    add("ns", opts.nb_samples);
    if (opts.overlap === false) add("o", 0);
    if (opts.inputs && opts.inputs !== 2) add("n", opts.inputs);
    if (opts.outputLabel && opts.outputLabel.length) {
      str += `[${opts.outputLabel}]`;
      return { filter: str, outputLabel: opts.outputLabel };
    }
    return { filter: str };
  }

  /**
   * Returns a human-readable ffmpeg command line for this worker.
   *
   * @returns string
   *
   * @example
   * console.log(worker.toString()); // e.g. "ffmpeg -i input.wav output.mp3"
   */
  toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  private _handleAbortSignal(): void {
    const { abortSignal } = this.config;
    if (!abortSignal) return;
    const onAbort = () => this.kill("SIGTERM");
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  private _handleTimeout(): void {
    if (this.config.timeout > 0) {
      this.timeoutHandle = setTimeout(() => {
        this.config.logger.warn?.(
          `[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`,
        );
        this.kill("SIGKILL");
      }, this.config.timeout);
    }
  }

  private _bindInputStream(): void {
    if (!this.inputStreams.length || !this.process?.stdin) return;
    const { stream: inputStream } =
      this.inputStreams.find((i) => i.index === 0) || this.inputStreams[0];
    pipeline(inputStream, this.process.stdin, (err) => {
      if (err) {
        if (err.code === "EPIPE" && (this.hasFinished || this.isTerminating)) {
          return;
        }
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Input pipeline failed: ${err.message}`,
        );
        this.emit("error", err);
        this._finalize(err);
      }
    });
  }

  private _bindOutputStreams(): void {
    if (!this.process || !this.outputStream) return;
    if (this.process.stdout) {
      pipeline(this.process.stdout, this.outputStream, (err) => {
        if (err) {
          if (
            err.message &&
            /premature close/i.test(err.message) &&
            (this.hasFinished ||
              this.isTerminating ||
              this.config.suppressPrematureCloseWarning)
          ) {
            return;
          }
          if (err.message && /premature close/i.test(err.message)) {
            this.config.logger.warn?.(
              `[${this.config.loggerTag}] Output pipeline warning: Premature close`,
            );
            return;
          }
          this.config.logger.error?.(
            `[${this.config.loggerTag}] Output pipeline failed: ${err.message}`,
          );
          this.emit("error", err);
          this._finalize(err);
        }
      });
    }
    // Placeholder for extra outputs (pipe:2, etc.)
    for (const {} of this.extraOutputs) {
    }
    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
  }

  private _bindProcessEvents(): void {
    this.process?.once("exit", (code, signal) =>
      this._onProcessExit(code, signal),
    );
    this.process?.once("error", (err: Error) => {
      this.config.logger.error?.(
        `[${this.config.loggerTag}] Process error: ${err.message}`,
      );
      this.emit("error", err);
      this._finalize(err);
    });
    this.process?.on("close", (code, signal) => {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] close event: code=${code} signal=${signal}`,
      );
    });
  }

  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
        this.stderrBuffer = this.stderrBuffer.slice(
          this.stderrBuffer.length - this.config.maxStderrBuffer,
        );
      }
    }
    if (this.config.enableProgressTracking) {
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line && line.includes("=")) {
          const progress = this._parseProgress(line);
          if (progress) {
            this.progress = { ...this.progress, ...progress };
            this.emit("progress", { ...this.progress });
          }
        }
      }
    }
  }

  private _onProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.hasFinished) return;
    this.config.logger.debug?.(
      `[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`,
    );
    const isSuccess = code === 0 || (signal !== null && this.isTerminating);
    if (isSuccess) {
      if (this.isTerminating) {
        this.emit("terminated", signal ?? "SIGTERM");
      }
      this.emit("end");
      this._finalize();
    } else {
      const error = this._getProcessExitError(code, signal);
      this.emit("error", error);
      this._finalize(error);
    }
  }

  private _getProcessExitError(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Error {
    const stderrSnippet = this.stderrBuffer.trim().slice(-1000);
    let message = `FFmpeg exited with code ${code}`;
    if (signal) message += ` (signal ${signal})`;
    if (stderrSnippet) {
      message += `.\nLast stderr output:\n${stderrSnippet}`;
    }
    return new Error(message);
  }

  private _finalize(error?: Error): void {
    if (this.hasFinished) return;
    this.hasFinished = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this._cleanup();
    if (error) {
      this.doneReject(error);
    } else {
      this.doneResolve();
    }
  }

  private _cleanup(): void {
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.outputStream?.destroy();
    for (const { stream } of this.extraOutputs) {
      stream.destroy();
    }
  }

  /**
   * Parse progress information from lines like "key1=val1 key2=val2".
   *
   * @private
   */
  private _parseProgress(line: string): Partial<FFmpegProgress> | null {
    const progress: Partial<FFmpegProgress> = {};
    const pairs = line.trim().split(/\s+/);
    for (const pair of pairs) {
      const [key, value] = pair.split("=", 2);
      if (!key || value == null) continue;
      switch (key) {
        case "frame":
          progress.frame = parseInt(value, 10);
          break;
        case "fps":
          progress.fps = parseFloat(value);
          break;
        case "bitrate":
          progress.bitrate = value;
          break;
        case "total_size":
          progress.totalSize = parseInt(value, 10);
          break;
        case "out_time_us":
          progress.outTimeUs = parseInt(value, 10);
          break;
        case "out_time":
          progress.outTime = value;
          break;
        case "dup_frames":
          progress.dupFrames = parseInt(value, 10);
          break;
        case "drop_frames":
          progress.dropFrames = parseInt(value, 10);
          break;
        case "speed":
          progress.speed = parseFloat(value.replace("x", ""));
          break;
        case "progress":
          progress.progress = value;
          break;
        case "size":
          progress.size = value;
          break;
        case "time":
          progress.time = value;
          break;
        case "packet":
          progress.packet = parseInt(value, 10);
          break;
        case "chapter":
          progress.chapter = parseInt(value, 10);
          break;
      }
    }
    return Object.keys(progress).length > 0 ? progress : null;
  }

  /**
   * Factory shortcut to create and configure a ProcessorWorker instance.
   *
   * @param params Object possibly including args, inputStreams, options, and/or any ProcessorOptions directly
   * @returns ProcessorWorker
   *
   * @example
   * // All-in-one .create usage:
   * const worker = ProcessorWorker.create({
   *   args: ['-i', 'a.wav', 'b.mp3'],
   *   inputStreams: [{ stream: fs.createReadStream('a.wav'), index: 0 }],
   *   ffmpegPath: '/usr/bin/ffmpeg',
   *   loggerTag: 'complexCase'
   * });
   */
  static create(
    params?: {
      args?: string[];
      inputStreams?: Array<{ stream: Readable; index: number }>;
      options?: ProcessorOptions;
    } & ProcessorOptions,
  ): Processor {
    if (!params) return new Processor();
    const { args, inputStreams, options, ...rest } = params;
    const workerOptions: ProcessorOptions = {
      ...(typeof options === "object" ? options : {}),
      ...rest,
    };
    const worker = new Processor(workerOptions);
    if (Array.isArray(args)) worker.setArgs(args);
    if (Array.isArray(inputStreams)) worker.inputStreams = [...inputStreams];
    return worker;
  }
}

export default Processor;
