import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import type { Logger, FFmpegProgress, FFmpegRunResultExtended } from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";

function escapeParam(val: string | number | undefined): string | number | undefined {
  if (typeof val !== "string") return val;
  return val.replace(/[:=]/g, (m) => "\\" + m);
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
  private trackDuration: number = 0;
  private readBytes = 0;

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
  private _runEmittedEnd = false;
  private _pendingProcessExitLog: (() => void) | null = null;

  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

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
      logger: (options.logger as Logger) ?? console,
      debug: options.debug ?? false,
      verbose: (options as any).verbose ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
    };
    this.extraGlobalArgs = [...this.config.extraGlobalArgs];
    this._initPromise();
    this._handleAbortSignal();
  }

  private _initPromise() {
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  private _log(stage: string, message: string, level: "debug" | "info" | "warn" | "error" = "debug") {
    const now = new Date();
    const timestamp = now.toLocaleTimeString("en-GB", { hour12: false }) + '.' + now.getMilliseconds().toString().padStart(3, '0');
    const logMsg = `[${timestamp}] [${this.config.loggerTag}] [${stage}] ${message}`;
    this.config.logger[level]?.(logMsg);
  }

  private async _getDuration(input: string): Promise<number> {
    try {
      const result = await execa('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        input
      ]);
      return parseFloat(result.stdout) || 0;
    } catch {
      return 0;
    }
  }

  public setArgs(args: string[]): this { this.args = Array.isArray(args) ? [...args] : []; return this; }
  public getArgs(): string[] { return [...this.args]; }
  public setInputStreams(streams: Array<{ stream: Readable; index: number }>): this { this.inputStreams = Array.isArray(streams) ? [...streams] : []; return this; }
  public getInputStream(): NodeJS.WritableStream | undefined { return this.process?.stdin ?? undefined; }
  public setExtraOutputStreams(streams: Array<{ stream: Writable; index: number }>): this { this.extraOutputs = Array.isArray(streams) ? [...streams] : []; return this; }
  public setExtraGlobalArgs(args: string[]): this { this.extraGlobalArgs = Array.isArray(args) ? [...args] : []; return this; }
  public getFullArgs(): string[] { return [...this.extraGlobalArgs, ...this.args]; }
  public isRunning(): boolean { return !!this.process && !this.hasFinished; }
  public getProgress(): Partial<FFmpegProgress> { return { ...this.progress }; }

  public reset(): void { this._resetRunState(); this._initPromise(); this._log("reset", "Processor state has been reset", "debug"); }

  public async run(): Promise<FFmpegRunResultExtended> {
    if (this.process) throw new Error("FFmpeg process is already running");

    this._resetRunState();
    this._initPromise();
    const fullArgs = this.getFullArgs();

    const inputArgIndex = fullArgs.findIndex(a => !a.startsWith('-') && !a.includes(':'));
    if (inputArgIndex >= 0) this.trackDuration = await this._getDuration(fullArgs[inputArgIndex]);

    this._log("run", `Starting ffmpeg: ${this.config.ffmpegPath} ${fullArgs.join(" ")}`, "debug");

    try {
      this.process = execa(this.config.ffmpegPath, fullArgs, {
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      });
    } catch (ex) {
      this._log("run", `Failed to spawn ffmpeg: ${(ex as Error).message}`, "error");
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();
    this._bindInputStream();
    this._setupOutputPipeline();

    this.process.once("exit", (code, signal) => this._onProcessExit(code, signal));
    this.process.once("error", (err: Error) => {
      this._log("process", `Error: ${err.message}`, "error");
      this.emit("error", err);
      this._finalize(err);
    });

    return {
      output: this.passthrough!,
      passthrough: this.passthrough!,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
    };
  }

  private _setupOutputPipeline() {
    if (!this.process?.stdout) return;

    const sampleRate = 48000;
    const channels = 2;
    const bytesPerSample = 2;
    const bytesPerSecond = sampleRate * channels * bytesPerSample;

    let output: PassThrough = this.extraOutputs.length ? new PassThrough() : (this.process.stdout as PassThrough);
    if (this.extraOutputs.length) {
      const teeHub = new PassThrough();
      pipeline(this.process.stdout, teeHub, (err) => { if (err) this.emit("error", err); });
      for (const { stream } of this.extraOutputs) {
        if (stream && typeof stream.write === "function") teeHub.pipe(stream, { end: false });
      }
      output = teeHub;
    }

    const passthrough = new PassThrough();
    this.outputStream = output;
    this.passthrough = passthrough;

    output.on("data", (chunk: Buffer) => {
      this.readBytes += chunk.length;
      const elapsedSec = this.readBytes / bytesPerSecond;
      const elapsedStr = new Date(elapsedSec * 1000).toISOString().substr(14, 5);
      const totalStr = this.trackDuration ? new Date(this.trackDuration * 1000).toISOString().substr(14, 5) : "??:??";
      this._log("progress", `${elapsedStr} / ${totalStr}`, "info");
      passthrough.write(chunk);
    });

    output.on("end", () => this._finalizeOutput());
    output.on("close", () => setImmediate(() => this._finalizeOutput()));
    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
  }

  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) this.stderrBuffer = this.stderrBuffer.slice(-this.config.maxStderrBuffer);
    }

    if (this.config.enableProgressTracking) {
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (!line || !line.includes("=")) continue;
        const progress = this._parseProgress(line);
        if (progress) {
          this.progress = { ...this.progress, ...progress };
          this.emit("progress", { ...this.progress });
        }
      }
    }
  }

  private _parseProgress(line: string): Partial<FFmpegProgress> | null {
    const obj: any = {};
    const parts = line.split(" ");
    for (const part of parts) {
      const [key, val] = part.split("=");
      if (!key || val === undefined) continue;
      if (key === "out_time") obj.outTime = val;
      else if (key === "frame") obj.frame = parseInt(val);
      else if (key === "speed") obj.speed = parseFloat(val.replace("x",""));
    }
    return Object.keys(obj).length ? obj : null;
  }

  private _resetRunState() {
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
    this.trackDuration = 0;
    this.readBytes = 0;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private _getBlackholeStream(): Writable {
    if (!this.blackholeStream) {
      this.blackholeStream = new Writable({ write(_c, _e, cb) { cb(); } });
    }
    return this.blackholeStream;
  }

  private _handleAbortSignal() {
    const { abortSignal } = this.config;
    if (!abortSignal) return;
    const onAbort = () => this.kill("SIGTERM");
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  private _handleTimeout() {
    if (!this.config.timeout) return;
    this.timeoutHandle = setTimeout(() => {
      this._log("timeout", `Process exceeded ${this.config.timeout}ms, terminating`, "warn");
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  private _bindInputStream() {
    if (!this.inputStreams.length || !this.process?.stdin) return;
    for (const { stream, index } of this.inputStreams) {
      if (!stream) continue;
      stream.on("error", (err) => {
        this._log("inputStream", `Error index=${index}: ${err.message}`, "error");
        this.emit("error", err);
        this._finalize(err);
      });
      if (index === 0) pipeline(stream, this.process.stdin, (err) => err && this._finalize(err));
      else pipeline(stream, this._getBlackholeStream(), () => {});
    }
  }

  private _finalizeOutput() {
    if (this._runEmittedEnd || this.hasFinished) return;
    this._runEmittedEnd = true;

    const buffer = this.createSilenceBuffer(100);
    const finalize = () => {
      this.passthrough?.end();
      this.emit('end');
      if (this._pendingProcessExitLog) {
        this._pendingProcessExitLog();
        this._pendingProcessExitLog = null;
      }
      this._finalize();
    };

    try {
      if (this.passthrough && !this.passthrough.destroyed) {
        if (!this.passthrough.write(buffer)) this.passthrough.once('drain', finalize);
        else setImmediate(finalize);
      } else setImmediate(finalize);
    } catch { setImmediate(finalize); }
  }

  private _onProcessExit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.hasFinished) return;
    if (code === 0 || (signal && this.isTerminating)) {
      this._log("exit", `Process exited code=${code} signal=${signal}`, "info");
      if (!this._runEmittedEnd) this._finalizeOutput();
    } else {
      const err = new Error(`FFmpeg exited with code=${code} signal=${signal}`);
      this._log("exit", `Abnormal exit: ${err.message}`, "error");
      this.emit("error", err);
      this._finalize(err);
    }
  }

  private _finalize(error?: Error) {
    if (this.hasFinished) return;
    this.hasFinished = true;

    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);

    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.outputStream?.destroy();
    this.passthrough?.destroy();
    this.blackholeStream?.destroy();
    for (const { stream } of this.extraOutputs) stream.destroy();

    if (error) this.doneReject?.(error);
    else this.doneResolve?.();

    this.process = null;
    this.outputStream = null;
    this.passthrough = null;
    this.blackholeStream = null;
    this.timeoutHandle = undefined;
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this._runEmittedEnd = true;

    this.passthrough?.end();
    this.passthrough?.destroy();
    this.outputStream?.destroy();

    this._log("close", "Processor streams closed", "debug");

    await this.kill();
    await this.donePromise;
    this._finalize();
  }

  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      this._log("kill", `Sending signal ${signal}`, "debug");
      this.process.kill(signal);
    }
    try { await this.donePromise; } catch (_) {}
  }

  public destroy(): void {
    this._log("destroy", "Processor forcefully destroyed", "warn");
    this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"));
    this.removeAllListeners();
  }

  public createSilenceBuffer(durationMs = 100, sampleRate = 48000, channels = 2) {
    const bytesPerSample = 2;
    const totalBytes = Math.floor((durationMs / 1000) * sampleRate * channels * bytesPerSample);
    return Buffer.alloc(totalBytes, 0);
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
    const buffer = this.createSilenceBuffer(durationMs, sampleRate, channels);
    return new Readable({
      read() { this.push(buffer); this.push(null); }
    });
  }

  static buildAcrossfadeFilter(opts: {
    inputs?: number;
    nb_samples?: number;
    duration?: number | string;
    overlap?: boolean;
    curve1?: string;
    curve2?: string;
    inputLabels?: string[];
    outputLabel?: string;
  } = {}): { filter: string; outputLabel?: string } {
    let filter = "acrossfade";
    let hasParam = false;
    const add = (key: string, val: string | number | undefined) => {
      if (val === undefined || val === "") return;
      filter += (hasParam ? ":" : "=") + key + "=" + escapeParam(val);
      hasParam = true;
    };
    add("d", opts.duration);
    add("c1", opts.curve1 ?? "tri");
    add("c2", opts.curve2 ?? "tri");
    add("ns", opts.nb_samples);
    if (opts.overlap === false) add("o", 0);
    if (opts.inputs && opts.inputs !== 2) add("n", opts.inputs);
    if (opts.outputLabel) filter += `[${opts.outputLabel}]`;
    return { filter, outputLabel: opts.outputLabel };
  }

  public toString(): string { return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`; }

  static create(params?: {
    args?: string[];
    inputStreams?: Array<{ stream: Readable; index: number }>;
    options?: ProcessorOptions;
  } & ProcessorOptions) {
    const worker = new Processor({ ...(params?.options ?? {}), ...(params ?? {}) });
    if (Array.isArray(params?.args)) worker.setArgs([...params.args]);
    if (Array.isArray(params?.inputStreams)) worker.inputStreams = [...params.inputStreams];
    return worker;
  }
}

export default Processor;
