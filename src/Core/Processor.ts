/**
 * Low-level FFmpeg process runner.
 *
 * This class is responsible for spawning the FFmpeg process, wiring stdin/stdout/stderr,
 * handling timeouts and termination, and emitting lifecycle/progress events.
 * It does not implement a fluent API and does not depend on the fluent wrapper.
 *
 * @fires Processor#start
 * @fires Processor#spawn
 * @fires Processor#progress
 * @fires Processor#end
 * @fires Processor#error
 * @fires Processor#terminated
 */
import { EventEmitter } from "eventemitter3";
import { type Readable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import {
  type SimpleFFmpegOptions,
  type FFmpegRunResult,
  type Logger,
  type FFmpegProgress,
} from "../Types/index.js";

/**
 * @typedef {object} ProcessorOptions
 * @augments SimpleFFmpegOptions
 */
export interface ProcessorOptions extends SimpleFFmpegOptions {}

/**
 * The FFmpeg process runner, responsible for running, controlling, and emitting events for an FFmpeg subprocess.
 * @class
 * @extends EventEmitter
 */
export class Processor extends EventEmitter {
  /**
   * Underlying FFmpeg process, or null if not started yet.
   * @private
   * @type {Subprocess | null}
   */
  private process: Subprocess | null = null;

  /**
   * Output stream from ffmpeg.
   * @private
   * @type {PassThrough | null}
   */
  private outputStream: PassThrough | null = null;

  /**
   * Input streams for ffmpeg with associated indices.
   * @private
   * @type {Array<{ stream: Readable; index: number }>}
   */
  private inputStreams: Array<{ stream: Readable; index: number }> = [];

  /**
   * Captured stderr buffer.
   * @private
   * @type {string}
   */
  private stderrBuffer = "";

  /**
   * Is the process terminating.
   * @private
   * @type {boolean}
   */
  private isTerminating = false;

  /**
   * Has the process finished.
   * @private
   * @type {boolean}
   */
  private finished = false;

  /**
   * Process timeout timer.
   * @private
   * @type {NodeJS.Timeout | undefined}
   */
  private timeoutHandle?: NodeJS.Timeout;

  /**
   * Internal resolve for done promise.
   * @private
   */
  private doneResolve!: () => void;
  /**
   * Internal reject for done promise.
   * @private
   */
  private doneReject!: (err: Error) => void;
  /**
   * Done promise, resolves or rejects when process ends.
   * @private
   * @readonly
   */
  private readonly donePromise: Promise<void>;

  /**
   * Complete static configuration.
   * @private
   * @readonly
   */
  private readonly config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
  };

  /**
   * PID of FFmpeg process. May be null if process has not started.
   * @readonly
   */
  public readonly pid: number | null = null;

  /**
   * Arguments for ffmpeg.
   * @private
   */
  private args: string[] = [];

  /**
   * Creates a new Processor instance.
   * @param {ProcessorOptions} [options] - FFmpeg process and runner options.
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
      abortSignal: options.abortSignal,
    };

    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });

    this.setupAbortSignal();
    this.applyInitialArgs();
  }

  /**
   * Set the FFmpeg argument list.
   * @param {string[]} args
   * @returns {this}
   */
  setArgs(args: string[]): this {
    this.args = [...args];
    return this;
  }

  /**
   * Set the input streams for ffmpeg (for stdin piping).
   * @param {Array<{ stream: Readable, index: number }>} streams
   * @returns {this}
   */
  setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = streams;
    return this;
  }

  /**
   * Launches the FFmpeg subprocess with the preset arguments and streams.
   * Also wires up output/pipeline, progress tracking and events.
   *
   * @throws {Error} If already running.
   * @returns {FFmpegRunResult} FFmpeg output and process done promise.
   * @fires Processor#start
   * @fires Processor#spawn
   */
  run(): FFmpegRunResult {
    if (this.process) throw new Error("FFmpeg process is already running");

    this.outputStream = new PassThrough();
    const fullCmd = `${this.config.ffmpegPath} ${this.args.join(" ")}`;
    /**
     * Emitted with the full command-line string when the process is about to start.
     * @event Processor#start
     * @type {string}
     */
    this.emit("start", fullCmd);
    this.config.logger.debug?.(`Starting: ${fullCmd}`);

    this.process = execa(this.config.ffmpegPath, this.args, {
      reject: false,
      all: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    (this as any).pid = this.process.pid ?? null;
    this.config.logger.debug?.(`PID: ${this.pid}`);

    this.setupTimeout();
    this.setupInputStreams();
    this.setupOutputStreams();
    this.setupProcessEvents();

    // Re-emit spawn so callers can reliably get PID
    /**
     * Emitted when the underlying process has spawned, with an object containing the PID.
     * @event Processor#spawn
     * @type {{ pid: number | null }}
     */
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
   * Forcefully terminate the ffmpeg process.
   * @param {NodeJS.Signals} [signal="SIGTERM"] Signal to send to child process.
   * @returns {void}
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      try {
        this.cleanup();
        this.process.kill(signal);
      } catch (error) {
        this.config.logger.error?.(`Kill error: ${error}`);
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error)),
        );
        this.finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Returns the full CLI command as a string.
   * @returns {string}
   */
  toString(): string {
    return `${this.config.ffmpegPath} ${this.args.join(" ")}`;
  }

  /**
   * Get a copy of the current ffmpeg argument array.
   * @returns {string[]}
   */
  getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Promise that resolves on process end, or rejects on error.
   * @readonly
   * @returns {Promise<void>}
   */
  get done(): Promise<void> {
    return this.donePromise;
  }

  /**
   * The ffmpeg subprocess stdout stream.
   * @readonly
   * @throws {Error} If process not yet started or stream is missing.
   * @returns {Readable}
   */
  get stdout(): Readable {
    if (!this.process?.stdout)
      throw new Error("FFmpeg process not started or stdout unavailable");
    return this.process.stdout;
  }

  // ====================== Private ======================

  /**
   * Attach abortSignal handling, if provided in options.
   * @private
   */
  private setupAbortSignal(): void {
    if (!this.config.abortSignal) return;
    if (this.config.abortSignal.aborted) {
      this.kill("SIGTERM");
    } else {
      this.config.abortSignal.addEventListener(
        "abort",
        () => this.kill("SIGTERM"),
        { once: true },
      );
    }
  }

  /**
   * Apply global/initial ffmpeg args from config.
   * @private
   */
  private applyInitialArgs(): void {
    if (this.config.extraGlobalArgs.length > 0)
      this.args.push(...this.config.extraGlobalArgs);
    if (this.config.failFast) this.args.push("-xerror");
    if (this.config.enableProgressTracking)
      this.args.push("-progress", "pipe:2");
  }

  /**
   * Setup a timeout trigger if configured.
   * @private
   */
  private setupTimeout(): void {
    if (this.config.timeout && this.config.timeout > 0) {
      this.timeoutHandle = setTimeout(() => {
        this.config.logger.warn?.(
          `Process timeout after ${this.config.timeout}ms`,
        );
        this.kill("SIGTERM");
      }, this.config.timeout);
    }
  }

  /**
   * Connect input stream(s) to ffmpeg stdin.
   * @private
   */
  private setupInputStreams(): void {
    if (this.inputStreams.length === 0 || !this.process?.stdin) return;
    const first = this.inputStreams[0];
    const endStdin = () => {
      if (this.process?.stdin && !this.process.stdin.destroyed)
        this.process.stdin.end();
    };
    first.stream.once("end", endStdin).once("close", endStdin);

    first.stream.on("error", (err) => {
      // Всегда логируем и эмитим ошибку
      this.config.logger.error?.(`Input stream error: ${err.message}`);
      this.emit("error", err);
      this.finish(err);
    });

    this.process.stdin.on("error", (err: any) => {
      // Only log EPIPE warning, don't emit error twice
      if ((err && err.code === "EPIPE") || `${err}`.includes("EPIPE")) {
        this.config.logger.warn?.(`Stdin error: write EPIPE`);
      } else {
        this.config.logger.error?.(`Stdin error: ${err.message ?? err}`);
        this.emit("error", err);
        this.finish(err);
      }
    });

    pipeline(first.stream, this.process.stdin, (err) => {
      if (err) {
        // If EPIPE and process is already ending, suppress excess error reporting
        if ((err.code === "EPIPE" || `${err}`.includes("EPIPE")) && this.finished) {
          // Swallow, because FFmpeg can close stdin when output pipeline closes
          return;
        }
        this.config.logger.error?.(`Pipeline failed: ${err.message}`);
        this.emit("error", err);
        this.finish(err);
      }
    });
  }

  /**
   * Setup output (stdout) and stderr event wiring to forward/pipe.
   * @private
   */
  private setupOutputStreams(): void {
    if (!this.process || !this.outputStream) return;
    this.process.stdout?.on("error", (e) => {
      this.config.logger.error?.(`stdout error: ${e}`);
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.finish(e instanceof Error ? e : new Error(String(e)));
    });
    this.process.stderr?.on("error", (e) => {
      this.config.logger.error?.(`stderr error: ${e}`);
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.finish(e instanceof Error ? e : new Error(String(e)));
    });

    if (this.process.stdout) {
      pipeline(this.process.stdout, this.outputStream, (err) => {
        if (err) {
          // Handle "premature close" as a warning if stdin also errored with EPIPE
          if (
            (err.message && /premature close/i.test(err.message)) &&
            this.finished
          ) {
            this.config.logger.warn?.("Output pipeline failed: Premature close");
            return;
          }
          this.config.logger.error?.(
            `Output pipeline failed: ${err.message}`
          );
          this.emit("error", err);
          this.finish(err);
        }
      });
    }

    this.process.stderr?.on("data", (chunk: Buffer) =>
      this.handleStderrData(chunk),
    );
  }

  /**
   * Setup non-stream process events (exit, error, cancel).
   * @private
   */
  private setupProcessEvents(): void {
    if (!this.process) return;
    this.process.once("exit", (code, signal) =>
      this.handleProcessExit(code, signal),
    );
    this.process.once("error", (err: Error) => {
      this.config.logger.error?.(`Process error: ${err.message}`);
      this.emit("error", err);
      this.finish(err);
    });
    this.process.on("cancel", () => this.kill("SIGTERM"));
  }

  /**
   * Handle incoming stderr data from ffmpeg and emit progress if enabled.
   * @private
   * @param {Buffer} chunk
   */
  private handleStderrData(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length + text.length > this.config.maxStderrBuffer) {
      this.stderrBuffer = this.stderrBuffer.slice(text.length);
    }
    this.stderrBuffer += text;

    if (this.config.enableProgressTracking) {
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.includes("=")) {
          const progress = this.parseProgress(line);
          /**
           * Emitted for each FFmpeg progress report line (if enabled).
           * @event Processor#progress
           * @type {Partial<FFmpegProgress>}
           */
          if (progress) this.emit("progress", progress);
        }
      }
    }
  }

  /**
   * Handle process exit/termination.
   * @private
   * @param {number|null} code
   * @param {NodeJS.Signals|null} signal
   */
  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.cleanup();
    const isRecoverableExit = code === 152 || code === 183 || code === 255;
    const isSuccess =
      (code === 0 && !this.isTerminating) ||
      this.isTerminating ||
      isRecoverableExit;
    if (isSuccess) {
      if (this.isTerminating || isRecoverableExit)
        /**
         * Emitted if process was terminated by signal or abnormal exit.
         * @event Processor#terminated
         * @type {NodeJS.Signals | string}
         */
        this.emit("terminated", signal ?? "SIGTERM");
      /**
       * Emitted at successful completion.
       * @event Processor#end
       */
      this.emit("end");
      this.finish();
    } else {
      const error = this.createExitError(code, signal);
      /**
       * Emitted if the process fails, with an Error.
       * @event Processor#error
       * @type {Error}
       */
      this.emit("error", error);
      this.finish(error);
    }
  }

  /**
   * Construct an Error object for FFmpeg exit with code/signal and stderr snippet.
   * @private
   * @param {number|null} code
   * @param {NodeJS.Signals|null} signal
   * @returns {Error}
   */
  private createExitError(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Error {
    const stderrSnippet = this.stderrBuffer.trim().slice(0, 2000);
    let message = `FFmpeg exited with code ${code}`;
    if (signal) message += `, signal ${signal}`;
    if (stderrSnippet)
      message += `, stderr: ${stderrSnippet.replace(/\n/g, " ")}`;
    return new Error(message);
  }

  /**
   * Trigger done promise resolution/rejection only once.
   * @private
   * @param {Error} [error]
   */
  private finish(error?: Error): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (error) this.doneReject(error);
    else this.doneResolve();
  }

  /**
   * Safely destroy streams and process fds.
   * @private
   */
  private cleanup(): void {
    try {
      this.outputStream?.destroy();
      this.process?.stdin?.end();
      this.process?.stdout?.destroy();
      this.process?.stderr?.destroy();
    } catch (error) {
      this.config.logger.error?.(`Cleanup error: ${error}`);
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Parse FFmpeg "-progress"-formatted key=value line to progress object.
   * @private
   * @param {string} line
   * @returns {Partial<FFmpegProgress> | null}
   */
  private parseProgress(line: string): Partial<FFmpegProgress> | null {
    const progress: Partial<FFmpegProgress> = {};
    const parts = line.split("=");
    for (let i = 0; i < parts.length - 1; i += 2) {
      const key = parts[i].trim();
      const value = parts[i + 1].trim();
      switch (key) {
        case "frame":
          progress.frame = Number.parseInt(value, 10);
          break;
        case "fps":
          progress.fps = Number.parseFloat(value);
          break;
        case "bitrate":
          progress.bitrate = value;
          break;
        case "total_size":
          progress.totalSize = Number.parseInt(value, 10);
          break;
        case "out_time_us":
          progress.outTimeUs = Number.parseInt(value, 10);
          break;
        case "out_time":
          progress.outTime = value;
          break;
        case "dup_frames":
          progress.dupFrames = Number.parseInt(value, 10);
          break;
        case "drop_frames":
          progress.dropFrames = Number.parseInt(value, 10);
          break;
        case "speed":
          progress.speed = Number.parseFloat(value.replace("x", ""));
          break;
        case "progress":
          progress.progress = value;
          break;
        default:
          break;
      }
    }
    return Object.keys(progress).length > 0 ? progress : null;
  }
}

export default Processor;
