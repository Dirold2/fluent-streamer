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
 * A class for spawning and managing FFmpeg processes, including progress,
 * lifecycle, killing by signal, and stream throttling for realtime output simulation.
 *
 * ### Features
 * - Stream input and output support
 * - Progress reporting and buffer management
 * - Realtime throttling for PCM/raw output formats (for "broadcast" simulation)
 * - Custom logger support
 * - AbortSignal-based cancellation and timeouts
 *
 * ### Usage Example
 * ```ts
 * import Processor from "./Core/Processor";
 * import { createReadStream } from "fs";
 *
 * const proc = new Processor({
 *   ffmpegPath: "/usr/bin/ffmpeg",
 *   enableProgressTracking: true,
 *   debug: true,
 *   timeout: 10000,
 * });
 *
 * proc.setArgs([
 *   "-f", "mp3",
 *   "-i", "pipe:0",
 *   "-f", "s16le",
 *   "-ar", "44100",
 *   "-ac", "2",
 *   "pipe:1"
 * ]);
 *
 * proc.setInputStreams([{ stream: createReadStream("input.mp3"), index: 0 }]);
 *
 * const { output, done, stop } = proc.run();
 * output.pipe(process.stdout);
 *
 * proc.on("progress", (info) => {
 *   console.log("FFmpeg progress", info);
 * });
 *
 * done
 *   .then(() => {
 *     console.log("Process finished.");
 *   })
 *   .catch((err) => {
 *     console.error("Process error:", err);
 *   });
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
   * Returns the PID of the FFmpeg process, or null if not running.
   */
  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /**
   * Constructs a Processor instance.
   * @param options - FFmpeg related options and configuration.
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
   * Set the arguments for FFmpeg process (excluding global extra args).
   * @param args - Arguments array for FFmpeg.
   */
  setArgs(args: string[]): this {
    this.args = Array.isArray(args) ? [...args] : [];
    return this;
  }

  /**
   * Returns a copy of the current argument list (excluding extra global args).
   */
  getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Set one or more input streams for FFmpeg. Pass an array of
   * `{ stream: Readable, index: number }` (index is used for complex FFmpeg invocations).
   *
   * @param streams - Array describing the input streams for FFMpeg.
   */
  setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  /**
   * Returns the running process's stdin writable stream, if available.
   */
  getInputStream(): NodeJS.WritableStream | undefined {
    return this.process?.stdin ?? undefined;
  }

  /**
   * Optional: Set extra output streams (not implemented in _bindOutputStreams yet).
   * Intended for writing to multiple output destinations.
   * @param streams - Array describing additional outputs.
   */
  setExtraOutputStreams(
    streams: Array<{ stream: Writable; index: number }>,
  ): this {
    this.extraOutputs = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  /**
   * Overwrite extra global arguments (prepended to FFmpeg args).
   * @param args - Arguments that go before main ffmpeg args.
   */
  setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = Array.isArray(args) ? [...args] : [];
    return this;
  }

  /**
   * Returns the complete list of arguments passed to FFmpeg, including global args.
   */
  getFullArgs(): string[] {
    return [...this.extraGlobalArgs, ...this.args];
  }

  /**
   * Creates a realtime-throttled PassThrough stream to limit PCM/raw stream data rate.
   * Used to simulate "live" streaming of PCM format output.
   *
   * @param sampleRate - PCM sample rate (Hz). Default: 44100 Hz.
   * @param bits - PCM bit depth per sample. Default: 16.
   * @param channels - Number of channels. Default: 2.
   * @returns A throttled PassThrough stream.
   */
  private _createRealtimeThrottleStream(
    sampleRate = 44100,
    bits = 16,
    channels = 2
  ): PassThrough {
    const bytesPerSample = bits / 8;
    const bytesPerSecond = sampleRate * bytesPerSample * channels;
    const throttle = new PassThrough();
    let lastPush = Date.now();
    let buffer: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;

    const pushLoop = () => {
      if (!buffer.length) {
        timer = null;
        return;
      }
      const now = Date.now();
      const elapsed = now - lastPush;
      lastPush = now;
      let bytesToSend = Math.floor((bytesPerSecond / 1000) * elapsed);

      let outBytes = 0;
      while (buffer.length && bytesToSend > 0) {
        const buf = buffer[0];
        if (buf.length <= bytesToSend) {
          throttle.push(buffer.shift());
          bytesToSend -= buf.length;
          outBytes += buf.length;
        } else {
          throttle.push(buf.slice(0, bytesToSend));
          buffer[0] = buf.slice(bytesToSend);
          outBytes += bytesToSend;
          bytesToSend = 0;
        }
      }
      if (buffer.length) {
        timer = setTimeout(pushLoop, 20);
      } else {
        timer = null;
      }
    };

    throttle._write = function(chunk, _encoding, cb) {
      buffer.push(Buffer.from(chunk));
      if (!timer) {
        timer = setTimeout(pushLoop, 20);
      }
      cb();
    };

    throttle._final = function(cb) {
      while (buffer.length) {
        throttle.push(buffer.shift());
      }
      cb();
    };

    return throttle;
  }

  /**
   * Launches the FFmpeg process with the currently set arguments and input streams.
   * If output is PCM or similar format, applies a realtime throttle to the output.
   *
   * @returns Object with { output, done, stop }:
   *   - output: ReadableStream for the FFmpeg stdout.
   *   - done: Promise resolved on process completion or rejected on error.
   *   - stop(): Function to kill the process.
   *
   * @example
   * const proc = new Processor({...}).setArgs([...]).run()
   * proc.output.pipe(fs.createWriteStream("output.pcm"))
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
    this._bindOutputStreams(true);
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
   * Kills the underlying FFmpeg process, sending a signal (default: SIGTERM).
   * @param signal - Node.js signal string (e.g. "SIGTERM")]
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
   * Build the acrossfade FFmpeg filter string.
   * Useful for audio cross-fading operations.
   *
   * @param opts - Filter options.
   * @returns Object with filter string and (optional) outputLabel.
   *
   * @example
   * Processor.buildAcrossfadeFilter({duration: 3, curve1: "exp", curve2: "exp"})
   * // { filter: "acrossfade=d=3:c1=exp:c2=exp" }
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
   * Returns CLI invocation string.
   */
  toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  /** Bind abort signal, if provided, to kill on abort. */
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

  /** Handles timeout by killing FFmpeg if the configured timeout is reached. */
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

  /** Binds a user-provided input stream to the FFmpeg process stdin. */
  private _bindInputStream(): void {
    if (!this.inputStreams.length || !this.process?.stdin) return;
    const { stream: inputStream } =
      this.inputStreams.find((i) => i.index === 0) || this.inputStreams[0];
    pipeline(inputStream, this.process.stdin, (err) => {
      if (err) {
        if ((err as any).code === "EPIPE" && (this.hasFinished || this.isTerminating)) {
          return;
        }
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Input pipeline failed: ${(err as Error).message}`,
        );
        this.emit("error", err);
        this._finalize(err as Error);
      }
    });
  }

  /**
   * Decide if output stream needs throttling; if so, wrap it in a throttling stream.
   * This applies to raw/pcm-like outputs (e.g. "-f s16le").
   *
   * @param applyThrottlePCM - If true, analyze arguments to possibly enable output throttling.
   */
  private _bindOutputStreams(applyThrottlePCM = false): void {
    if (!this.process || !this.outputStream) return;

    let isPCM = false;
    let sampleRate = 44100;
    let bits = 16;
    let channels = 2;

    const args = this.getFullArgs();
    for (let i = 0; i < args.length; ++i) {
      if (args[i] === "-f" && typeof args[i + 1] === "string") {
        const fmt = args[i + 1];
        if (
          /^s(8|16|24|32)le$/.test(fmt) ||
          /^f(32|64)le$/.test(fmt) ||
          fmt === "s16be" ||
          fmt === "f32be" ||
          fmt === "f64be" ||
          fmt === "u8" ||
          fmt === "pcm_s16le" ||
          fmt === "pcm_s16be" ||
          fmt === "pcm_f32le" ||
          fmt === "pcm_f32be" ||
          fmt === "rawaudio" ||
          fmt === "wav"
        ) {
          isPCM = true;
        }
      }
      if (args[i] === "-ar" && typeof args[i + 1] === "string") {
        const s = parseInt(args[i + 1], 10);
        if (s > 1000 && s < 384000) sampleRate = s;
      }
      if (args[i] === "-ac" && typeof args[i + 1] === "string") {
        const c = parseInt(args[i + 1], 10);
        if (c > 0 && c < 32) channels = c;
      }
      if (args[i] === "-sample_fmt" && typeof args[i + 1] === "string") {
        if (/^s(8|16|24|32)/.test(args[i + 1])) {
          bits = parseInt(args[i + 1].replace(/[^\d]/g, ""), 10);
        }
        if (/^f(32|64)/.test(args[i + 1])) {
          bits = parseInt(args[i + 1].replace(/[^\d]/g, ""), 10);
        }
      }
    }

    const onPipelineError = (err: Error | null) => {
      if (!err) return;
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
    };

    if (this.process.stdout) {
      if (applyThrottlePCM && isPCM) {
        const throttle = this._createRealtimeThrottleStream(sampleRate, bits, channels);
        pipeline(this.process.stdout, throttle, this.outputStream, onPipelineError);
      } else {
        pipeline(this.process.stdout, this.outputStream, onPipelineError);
      }
    }

    // TODO: Support extraOutputs as independent pipelines

    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
  }

  /** Bind process-level events for cleanup and reporting. */
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

  /** Handles progress-parsing and stderr buffer management. */
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

  /** Handles process exit, cleans up, and emits appropriate events. */
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
   * Create an Error describing FFmpeg process exit with useful stderr output included.
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
   * Final cleanup: stop timeouts, release streams, resolve/reject the done promise.
   * @param error - Error to reject with (optional; otherwise will resolve).
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
   * Cleanup resources/streams. Always called on process completion.
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
   * Attempts to parse a single FFmpeg progress line into a FFmpegProgress object.
   * @param line - FFmpeg stderr output line.
   * @returns Partial FFmpegProgress info (or null if no recognized keys).
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
   * Create a Processor instance with quick-style options for convenience.
   *
   * @example
   * Processor.create({
   *   args: ["-i", "input.mp3", ...],
   *   options: { ffmpegPath: "/usr/bin/ffmpeg" }
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
