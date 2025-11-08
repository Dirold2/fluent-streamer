import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import type {
  Logger,
  FFmpegProgress,
  FFmpegRunResultExtended,
} from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";

function escapeParam(val: string | number | undefined): string | number | undefined {
  if (typeof val !== "string") return val;
  return val.replace(/[:=]/g, (m) => `\\${m}`);
}

export class Processor extends EventEmitter {
  private process: Subprocess | null = null;
  private passthrough: PassThrough | null = null;
  private outputStream: PassThrough | null = null;
  private blackholeStream: Writable | null = null;
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private extraOutputs: Array<{ stream: Writable; index: number }> = [];
  private stderrBuffer = "";
  private isTerminating = false;
  private hasFinished = false;
  private isClosed = false;
  private timeoutHandle?: NodeJS.Timeout;
  private progress: Partial<FFmpegProgress> = {};

  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private donePromise: Promise<void> | null = null;

  private readonly config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
  };

  private args: string[] = [];
  private extraGlobalArgs: string[] = [];

  // Run-state
  private _runEnded = false;
  private _runEmittedEnd = false;
  private _doEndSequence: (() => void) | null = null;
  private _pendingProcessExitLog: (() => void) | null = null;

  constructor(options: ProcessorOptions = {}) {
    super();

    this.config = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      failFast: options.failFast ?? false,
      extraGlobalArgs: options.extraGlobalArgs ?? [],
      loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
      inputStreams: options.inputStreams ?? [],
      onBeforeChildProcessSpawn: options.onBeforeChildProcessSpawn ?? (() => {}),
      stderrLogHandler: options.stderrLogHandler ?? (() => {}),
      executionId: options.executionId ?? (Math.random().toString(36).slice(2) + Date.now()),
      wallTimeLimit: options.wallTimeLimit ?? 0,
      timeout: options.timeout ?? 0,
      maxStderrBuffer: options.maxStderrBuffer ?? 1024 * 1024,
      enableProgressTracking: options.enableProgressTracking ?? false,
      logger: options.logger as Logger ?? console,
      debug: options.debug ?? false,
      verbose: (options as any).verbose ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
    };

    this.extraGlobalArgs = [...this.config.extraGlobalArgs];

    this._initDonePromise();
    this._handleAbortSignal();
  }

  private _initDonePromise(): void {
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  public setArgs(args: string[]): this {
    this.args = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public getArgs(): string[] {
    return [...this.args];
  }

  public setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  public getInputStream(): NodeJS.WritableStream | undefined {
    return this.process?.stdin ?? undefined;
  }

  public setExtraOutputStreams(streams: Array<{ stream: Writable; index: number }>): this {
    this.extraOutputs = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  public setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public getFullArgs(): string[] {
    return [...this.extraGlobalArgs, ...this.args];
  }

  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  public isRunning(): boolean {
    return !!this.process && !this.hasFinished;
  }

  public getProgress(): Partial<FFmpegProgress> {
    return { ...this.progress };
  }

  public reset(): void {
    this._resetRunState();
  }

  public run(): FFmpegRunResultExtended {
    if (this.process) throw new Error("FFmpeg process is already running");

    this._resetRunState();
    this._initDonePromise();

    this._logDebug(`[${this.config.loggerTag}] Starting ffmpeg process: ${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`);

    const fullArgs = this.getFullArgs();

    try {
      this.process = execa(this.config.ffmpegPath, fullArgs, {
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (ex) {
      this._logError(`[${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`);
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();
    this._bindInputStreams();

    // Setup output streams handling
    let output: PassThrough = this.process.stdout
      ? (this.extraOutputs.length ? new PassThrough() : (this.process.stdout as PassThrough))
      : new PassThrough();

    if (this.extraOutputs.length > 0 && this.process.stdout) {
      const teeHub = new PassThrough();
      pipeline(this.process.stdout, teeHub, (err) => {
        if (err && !/premature close/i.test(err.message)) this.emit("error", err);
      });
      for (const { stream } of this.extraOutputs) {
        if (stream) {
          teeHub.pipe(stream, { end: false });
        }        
      }
      output = teeHub;
    }

    this.passthrough = new PassThrough();
    this.outputStream = output;
    this._ensureOutputDrained();

    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));

    this.process.once("exit", (code, signal) => {
      this._pendingProcessExitLog = () => {
        this._logDebug(`[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`);
      };
      this._onProcessExit(code, signal);
    });

    this.process.once("error", (err: Error) => {
      this._logError(`[${this.config.loggerTag}] Process error: ${err.message}`);
      this.emit("error", err);
      this._finalize(err);
    });

    output.on("data", (chunk) => this.passthrough?.write(chunk));

    output.on("end", () => {
      this._runEnded = true;
      this._doEndSequence?.();
    });

    output.on("close", () => {
      if (!this._runEnded) {
        this._runEnded = true;
        setImmediate(() => this._doEndSequence?.());
      }
    });

    this._doEndSequence = () => {
      if (this._runEmittedEnd || this.hasFinished || this.isClosed) return;
      this._runEmittedEnd = true;

      const buffer = this.createSilenceBuffer(100);

      const finalize = () => {
        this.passthrough?.end();
        setImmediate(() => {
          this.emit("end");
          this._pendingProcessExitLog?.();
          this._pendingProcessExitLog = null;
          this._finalize();
        });
      };

      try {
        if (this.passthrough && !this.passthrough.destroyed && !this.hasFinished && !this.isClosed) {
          const written = this.passthrough.write(buffer);
          if (!written) {
            this.passthrough.once("drain", finalize);
          } else {
            setImmediate(finalize);
          }
        } else {
          setImmediate(finalize);
        }
      } catch {
        setImmediate(finalize);
      }
    };

    this.donePromise!.catch((err: Error) => {
      this.emit("error", err);
      if (!this._runEmittedEnd && this.passthrough && !this.passthrough.destroyed) {
        this.passthrough.destroy(err);
      }
    });

    return {
      output: this.passthrough,
      passthrough: this.passthrough,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
    };
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;

    this.isClosed = true;
    this._runEmittedEnd = true;

    this.passthrough?.end();
    this.passthrough?.destroy();
    this.outputStream?.destroy();

    this._logDebug(`[${this.config.loggerTag}] Closed processor stream via .close()`);

    await this.kill();
    await this.donePromise;
    this._finalize();
  }

  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      this._logDebug(`[${this.config.loggerTag}] Killing process with signal ${signal}`);
      this.process.kill(signal);
    }
    try {
      await this.donePromise;
    } catch {
      // swallow errors from kill
    }
  }

  public destroy(): void {
    this._logWarn(`[${this.config.loggerTag}] Processor force destroy() called at ${new Date().toISOString()}`);
    this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"));
    this.removeAllListeners();
  }

  public static buildAcrossfadeFilter(opts: {
    inputs?: number;
    nb_samples?: number;
    duration?: number | string;
    overlap?: boolean;
    curve1?: string;
    curve2?: string;
    inputLabels?: string[];
    outputLabel?: string;
  } = {}) {
    let filter = "acrossfade";
    let hasParam = false;
    const addParam = (key: string, val: string | number | undefined) => {
      if (val === undefined || val === "") return;
      filter += (hasParam ? ":" : "=") + `${key}=${escapeParam(val)}`;
      hasParam = true;
    };

    addParam("d", opts.duration);
    addParam("c1", opts.curve1 ?? "tri");
    addParam("c2", opts.curve2 ?? "tri");
    addParam("ns", opts.nb_samples);
    if (opts.overlap === false) addParam("o", 0);
    if (opts.inputs && opts.inputs !== 2) addParam("n", opts.inputs);

    if (opts.outputLabel && opts.outputLabel.length) {
      filter += `[${opts.outputLabel}]`;
      return { filter, outputLabel: opts.outputLabel };
    }
    return { filter };
  }

  public toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  public debugDump() {
    return {
      pid: this.pid,
      args: this.getArgs(),
      fullArgs: this.getFullArgs(),
      isClosed: this.isClosed,
      hasFinished: this.hasFinished,
      isTerminating: this.isTerminating,
      running: !!this.process,
      runEnded: this._runEnded,
      runEmittedEnd: this._runEmittedEnd,
      extraGlobalArgs: [...this.extraGlobalArgs],
      stderrBufferLength: this.stderrBuffer.length,
      timeoutHandle: !!this.timeoutHandle,
      progress: { ...this.progress },
      inputStreamsCount: this.inputStreams.length,
      extraOutputsCount: this.extraOutputs.length,
      timestamp: new Date().toISOString(),
    };
  }

  // PRIVATE HELPERS

  private _resetRunState(): void {
    if (this.outputStream && (this.outputStream as any)._ffmpegDrainAttached) {
      delete (this.outputStream as any)._ffmpegDrainAttached;
    }

    this._runEnded = false;
    this._runEmittedEnd = false;
    this._pendingProcessExitLog = null;
    this.isClosed = false;
    this.hasFinished = false;
    this.isTerminating = false;
    this.stderrBuffer = "";
    this.progress = {};
    this.process = null;
    this.outputStream = null;
    this.passthrough = null;
    this.blackholeStream = null;

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private _getBlackholeStream(): Writable {
    if (!this.blackholeStream) {
      this.blackholeStream = new Writable({
        write(_chunk, _encoding, cb) { cb(); },
      });
    }
    return this.blackholeStream;
  }

  private _ensureOutputDrained(): void {
    if (!this.outputStream) return;
    if ((this.outputStream as any)._ffmpegDrainAttached) return;

    let readDetected = false;
    const markRead = () => {
      readDetected = true;
      (this.outputStream as any)._ffmpegDrainAttached = true;
    };

    const events = ["data", "readable", "end", "close"];
    const checkReadListeners = () => {
      const listeners = (this.outputStream as any).listeners?.("data") ?? [];
      return listeners.length > 1;
    };

    const maybeDrain = () => {
      if (!readDetected && this.outputStream && !(this.outputStream as any)._ffmpegDrainAttached && !checkReadListeners()) {
        (this.outputStream as any)._ffmpegDrainAttached = true;
        this.outputStream.pipe(this._getBlackholeStream());
        this._logDebug(`[${this.config.loggerTag}] Output PassThrough drained to blackhole to prevent Broken pipe`);
      }
    };

    for (const ev of events) {
      this.outputStream.once(ev, markRead);
    }

    this.outputStream.once("newListener", (event: string) => {
      if (events.includes(event)) {
        markRead();
        clearTimeout(timer);
      }
    });

    const timer = setTimeout(maybeDrain, 100);
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2): Readable {
    const buffer = this.createSilenceBuffer(durationMs, sampleRate, channels);
    return new Readable({
      read() {
        this.push(buffer);
        this.push(null);
      },
    });
  }

  public createSilenceBuffer(durationMs = 100, sampleRate = 48000, channels = 2): Buffer {
    const bytesPerSample = 2;
    const totalBytes = Math.floor((durationMs / 1000) * sampleRate * channels * bytesPerSample);
    return Buffer.alloc(totalBytes, 0);
  }

  private _handleAbortSignal(): void {
    if (!this.config.abortSignal) return;
    const onAbort = () => this.kill("SIGTERM");
    if (this.config.abortSignal.aborted) {
      onAbort();
    } else {
      this.config.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  private _handleTimeout(): void {
    if (!this.config.timeout) return;
    this.timeoutHandle = setTimeout(() => {
      this._logWarn(`[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`);
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  private _bindInputStreams(): void {
    if (!this.inputStreams.length || !this.process?.stdin) return;

    for (const { stream, index } of this.inputStreams) {
      if (!stream) continue;

      stream.on("error", (err) => {
        this._logError(`[${this.config.loggerTag}] Input stream error [index=${index}]: ${(err as Error).message}`);
        this.emit("error", err);
        this._finalize(err as Error);
      });

      stream.on("end", () => {
        this._logDebug(`[${this.config.loggerTag}] Input stream ended [index=${index}]`);
      });

      if (index === 0) {
        pipeline(stream, this.process.stdin, (err) => {
          if (err) {
            if ((err as any).code === "EPIPE" && (this.hasFinished || this.isTerminating)) return;
            this._logError(`[${this.config.loggerTag}] Input pipeline failed [index=0]: ${(err as Error).message}`);
            this.emit("error", err);
            this._finalize(err as Error);
          }
        });
      } else {
        pipeline(stream, this._getBlackholeStream(), () => {});
      }
    }
  }

  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
        this.stderrBuffer = this.stderrBuffer.slice(-this.config.maxStderrBuffer);
      }
    }
    if (this.config.enableProgressTracking) {
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.includes("=")) {
          const progress = this._parseProgress(line);
          if (progress) {
            this.progress = { ...this.progress, ...progress };
            this.emit("progress", { ...this.progress });
          }
        }
      }
    }
  }

  private _onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.hasFinished) return;

    if (code === 0 || (signal && this.isTerminating)) {
      if (this.isTerminating) this.emit("terminated", signal ?? "SIGTERM");

      this.config.logger.info?.(`[${this.config.loggerTag}] Process exited normally with code ${code}, signal ${signal} at ${new Date().toISOString()}`);

      if (!this._runEmittedEnd) {
        this._runEnded = true;
        setImmediate(() => this._doEndSequence?.());
      }
    } else {
      const error = this._getProcessExitError(code, signal);
      const tail = this.stderrBuffer.trim().slice(-4000);
      if (tail && (this.config.debug || this.config.verbose)) {
        this._logError(`[${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`);
      }
      this.emit("error", error);
      this._finalize(error);
    }
  }

  private _getProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const snippet = this.stderrBuffer.trim().slice(-1000);
    let msg = `FFmpeg exited with code ${code}`;
    if (signal) msg += ` (signal ${signal})`;
    if (snippet) msg += `.\nLast stderr output:\n${snippet}`;
    return new Error(msg);
  }

  private _finalize(error?: Error): void {
    if (this.hasFinished) return;
    this.hasFinished = true;

    try {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      this._cleanup();

      if (error) {
        this.doneReject(error);
      } else {
        this.doneResolve();
      }
    } finally {
      this.process = null;
      this.outputStream = null;
      this.passthrough = null;
      this.blackholeStream = null;
      this.timeoutHandle = undefined;
    }
  }

  private _cleanup(): void {
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.outputStream?.destroy();
    this.passthrough?.destroy();
    this.blackholeStream?.destroy();

    for (const { stream } of this.extraOutputs) {
      stream.destroy();
    }

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private _parseProgress(line: string): Partial<FFmpegProgress> | null {
    const progress: Partial<FFmpegProgress> = {};
    for (const pair of line.trim().split(/\s+/)) {
      const [key, value] = pair.split("=", 2);
      if (!key || value == null) continue;

      switch (key) {
        case "frame": progress.frame = Number(value); break;
        case "total_size": progress.totalSize = Number(value); break;
        case "out_time_us": progress.outTimeUs = Number(value); break;
        case "dup_frames": progress.dupFrames = Number(value); break;
        case "drop_frames": progress.dropFrames = Number(value); break;
        case "packet": progress.packet = Number(value); break;
        case "chapter": progress.chapter = Number(value); break;
        case "fps": progress.fps = parseFloat(value.replace("x", "")); break;
        case "speed": progress.speed = parseFloat(value.replace("x", "")); break;
        case "bitrate": progress.bitrate = value; break;
        case "size": progress.size = value; break;
        case "out_time": progress.outTime = value; break;
        case "progress": progress.progress = value; break;
        case "time": progress.time = value; break;
      }
    }
    return Object.keys(progress).length > 0 ? progress : null;
  }

  private _logDebug(message: string) {
    if (this.config.debug || this.config.verbose) this.config.logger.debug?.(message);
  }

  private _logError(message: string) {
    this.config.logger.error?.(message);
  }

  private _logWarn(message: string) {
    this.config.logger.warn?.(message);
  }

  static create(params?: {
    args?: string[];
    inputStreams?: Array<{ stream: Readable; index: number }>;
    options?: ProcessorOptions;
  } & ProcessorOptions): Processor {
    if (!params || typeof params !== "object") return new Processor();

    const workerArgs = Array.isArray(params.args) ? [...params.args] : undefined;
    const workerInputStreams = Array.isArray(params.inputStreams)
      ? params.inputStreams.map(({ stream, index }) => ({ stream, index }))
      : undefined;

    const { args, inputStreams, options: extraOptions, ...restParams } = params as any;
    const optionsObj = { ...(typeof extraOptions === "object" ? extraOptions : {}), ...restParams };

    const worker = new Processor(optionsObj);
    if (workerArgs) worker.setArgs(workerArgs);
    if (workerInputStreams) worker.inputStreams = workerInputStreams;
    return worker;
  }
}

export default Processor;
