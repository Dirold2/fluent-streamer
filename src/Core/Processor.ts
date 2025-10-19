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
 * Class for launching and managing FFmpeg processes, their lifecycle and progress.
 *
 * @example
 * ```typescript
 * import Processor from './Processor';
 * const proc = new Processor({ ffmpegPath: 'ffmpeg' });
 * proc.setArgs(['-i', 'input.mp3', 'output.wav']);
 * const { output, done, stop } = proc.run();
 * output.pipe(fs.createWriteStream('output.wav'));
 * await done;
 * ```
 *
 * @fires Processor#progress
 * @fires Processor#error
 * @fires Processor#end
 * @fires Processor#terminated
 * @fires Processor#start
 * @fires Processor#spawn
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
   * Gets the PID of the running FFmpeg process (null if not running).
   */
  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * Constructs a Processor object.
   * @param options ProcessorOptions
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
      debug: options.debug ?? false,
      suppressPrematureCloseWarning:
        options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
    };
    this.extraGlobalArgs = [...this.config.extraGlobalArgs];

    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });

    this._handleAbortSignal();
  }

  /**
   * Sets the FFmpeg argument list.
   * @param args Arguments array (e.g. ['-i', 'input', 'output'])
   * @returns this
   */
  setArgs(args: string[]): this {
    this.args = [...args];
    return this;
  }

  /**
   * Returns the current FFmpeg argument list.
   * @returns Arguments array
   */
  getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Sets the input streams for FFmpeg.
   * @param streams Array of objects: { stream, index }
   * @returns this
   */
  setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = [...streams];
    return this;
  }

  /**
   * Returns FFmpeg's stdin stream if available.
   */
  getInputStream(): NodeJS.WritableStream | undefined {
    return this.process?.stdin ?? undefined;
  }

  /**
   * Sets additional writable outputs for FFmpeg auxiliary pipes (e.g. pipe:2).
   * @param streams Array of objects: { stream, index }
   * @returns this
   */
  setExtraOutputStreams(
    streams: Array<{ stream: Writable; index: number }>,
  ): this {
    this.extraOutputs = [...streams];
    return this;
  }

  /**
   * Sets extra arguments to be prepended globally to the FFmpeg command.
   * @param args Arguments array
   * @returns this
   */
  setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = [...args];
    return this;
  }

  /**
   * Returns the complete argument list passed to FFmpeg (extraGlobalArgs + args).
   * @returns Arguments array
   */
  getFullArgs(): string[] {
    return [...this.extraGlobalArgs, ...this.args];
  }

  /**
   * Runs the FFmpeg process using the current options and argument list.
   * Binds IO, process events, progress updates.
   *
   * @returns {{ output: PassThrough, done: Promise<void>, stop: () => void }}
   *
   * @example
   * const proc = new Processor();
   * proc.setArgs(['-i', 'input.mp4', 'output.mp3']);
   * const { output, done, stop } = proc.run();
   * output.pipe(fs.createWriteStream('output.mp3'));
   * await done;
   */
  run(): FFmpegRunResult {
    if (this.process) throw new Error("FFmpeg process is already running");
    this.outputStream = new PassThrough();

    const fullArgs = this.getFullArgs();
    const fullCmd = `${this.config.ffmpegPath} ${fullArgs.join(" ")}`;

    this.emit("start", fullCmd);
    if (this.config.debug!) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Starting: ${fullCmd}`,
      );
    }

    this.process = execa(this.config.ffmpegPath, fullArgs, {
      reject: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    if (this.config.debug!) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] PID: ${this.process.pid ?? null}`,
      );
    }

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
   * Kills the FFmpeg process.
   * @param signal Signal to send (default: "SIGTERM")
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      if (this.config.debug) {
        this.config.logger.debug?.(
          `[${this.config.loggerTag}] Killing process with signal ${signal}`,
        );
      }
      this.process.kill(signal);
    }
  }

  /**
   * Builds an "acrossfade" FFmpeg filter string.
   * @param opts Filter options
   * @returns { filter: string, outputLabel?: string }
   * @example
   * Processor.buildAcrossfadeFilter({ duration: 2, curve1: 'exp', curve2: 'sin' });
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
    let filter = "acrossfade";
    let hasParam = false;
    const add = (key: string, val: string | number | undefined) => {
      if (val === undefined || val === "") return;
      filter += (hasParam ? ":" : "=") + key + "=" + val;
      hasParam = true;
    };
    add("d", opts.duration);
    add("c1", opts.curve1 ?? "tri");
    add("c2", opts.curve2 ?? "tri");
    add("ns", opts.nb_samples);
    if (opts.overlap === false) add("o", 0);
    if (opts.inputs && opts.inputs !== 2) add("n", opts.inputs);
    if (opts.outputLabel && opts.outputLabel.length) {
      filter += `[${opts.outputLabel}]`;
      return { filter, outputLabel: opts.outputLabel };
    }
    return { filter };
  }

  /**
   * Returns the FFmpeg command line as string.
   * @returns Command string
   * @example
   * processor.toString(); // "ffmpeg -i foo.mp3 bar.wav"
   */
  toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  /**
   * Sets up abort signal support.
   * If abortSignal is triggered, will kill the process.
   * @private
   */
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

  /**
   * Sets up process timeout (if timeout > 0).
   * @private
   */
  private _handleTimeout(): void {
    if (this.config.timeout > 0) {
      this.timeoutHandle = setTimeout(() => {
        if (this.config.debug) {
          this.config.logger.warn?.(
            `[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`,
          );
        }
        this.kill("SIGKILL");
      }, this.config.timeout);
    }
  }

  /**
   * Connects the first input stream (if any) to the FFmpeg process stdin.
   * @private
   */
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

  /**
   * Connects process.stdout to outputStream and sets up stderr handling.
   * @private
   */
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
            if (this.config.debug) {
              this.config.logger.warn?.(
                `[${this.config.loggerTag}] Output pipeline warning: Premature close`,
              );
            }
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
    // for (const {} of this.extraOutputs) {} // Not implemented

    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
  }

  /**
   * Binds process exit/error/close events.
   * @private
   */
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
      if (this.config.debug) {
        this.config.logger.debug?.(
          `[${this.config.loggerTag}] close event: code=${code} signal=${signal}`,
        );
      }
    });
  }

  /**
   * Handles and buffers stderr data for diagnostics and progress tracking.
   * @private
   */
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

  /**
   * Handles the process exit logic.
   * @private
   */
  private _onProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.hasFinished) return;
    if (this.config.debug) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`,
      );
    }
    if (code === 0 || (signal !== null && this.isTerminating)) {
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

  /**
   * Formats process exit error with code, signal and last stderr snippet.
   * @private
   */
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

  /**
   * Finalizes the process state, cleans up, and resolves/rejects as needed.
   * @param error Error, if any
   * @private
   */
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

  /**
   * Cleans up streams used by this process.
   * @private
   */
  private _cleanup(): void {
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.outputStream?.destroy();
    for (const { stream } of this.extraOutputs) {
      stream.destroy();
    }
  }

  /**
   * Parses a single line of FFmpeg progress output.
   * @param line FFmpeg progress line
   * @returns Progress object or null
   * @private
   * @example
   * // frame=882 fps=28.94 ... time=00:00:29.43
   * const progress = processor._parseProgress('frame=100 fps=45.0 ...');
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
   * Creates a Processor instance using argument bag.
   * @param params Processor options, args, inputStreams
   * @returns Processor
   * @example
   * const p = Processor.create({
   *   args: ['-i', 'a.mp4', 'b.mp3'],
   *   inputStreams: [{ stream: s, index: 0 }],
   *   timeout: 5000,
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
