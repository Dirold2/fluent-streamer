import { EventEmitter } from "eventemitter3";
import { ffmpegManager } from "../Runner/FFmpegRunner.js";
import type { FFmpegProcess } from "../Types/core.js";
import type {
  ProcessorDebugInfo,
  InputSource,
  ProcessorOptions,
  FFmpegRunResultExtended,
} from "../Types/index.js";
import { AudioEffectController } from "../Audio/AudioEffectController.js";
import { getTimeString } from "./utils.js";
import { buildFullArgs } from "./processor/args.js";
import { resolveBlobToStream } from "./processor/blob.js";
import {
  buildProcessorConfig,
  type ProcessorConfig,
} from "./processor/config.js";
import { buildAcrossfadeFilter } from "./processor/acrossfade.js";
import {
  ensureOutputDrained,
  pipeInputStreams,
  createAudioProcessor,
  setupOutputPipeline,
  updateThrottleBitrate,
} from "./processor/pipeline.js";
import { createSilenceBuffer, createSilenceMs } from "./processor/silence.js";
import {
  StderrTracker,
  buildProcessExitError,
  readStderrStream,
} from "./processor/stderr.js";
import { resolveFfmpegPath } from "./processor/ffmpegPath.js";

type ProcessorState =
  "idle" | "running" | "terminating" | "finished" | "failed" | "closed";
type TerminationReason = "user" | "close" | "timeout" | "destroy" | null;

export class Processor extends EventEmitter {
  private process: FFmpegProcess | null = null;
  private outputStream: ReadableStream<Uint8Array> | null = null;
  private inputStreams: Array<{
    stream: ReadableStream<Uint8Array>;
    index: number;
  }> = [];
  private extraOutputs: Array<{
    stream: WritableStream<Uint8Array>;
    index: number;
  }> = [];
  private processState: ProcessorState = "idle";
  private terminationReason: TerminationReason = null;
  private isTerminating = false;
  private hasFinished = false;
  private isClosed = false;
  private doneSettled = false;
  private timeoutHandle?: ReturnType<typeof setTimeout>;
  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private donePromise: Promise<void> | null = null;
  private args: string[] = [];
  private extraGlobalArgs: string[] = [];
  private _runEnded = false;
  private _runEmittedEnd = false;
  private _pendingProcessExitLog: (() => void) | null = null;
  private useAudioProcessor = false;
  private endSequenceFn: (() => void) | null = null;
  private throttledOutput: TransformStream<Uint8Array, Uint8Array> | null =
    null;
  private _pipelinePromise: Promise<void> | null = null;
  private currentVolume = 1;
  private currentBass = 0;
  private currentTreble = 0;
  private currentCompressor = false;
  private currentNormalize = false;
  private _startTime = 0;
  private _totalChunks = 0;
  private _skipInProgress = false;
  private _lastSkipTime = 0;
  private readonly SKIP_DEBOUNCE_MS = 500;

  private readonly config: ProcessorConfig;
  private readonly stderrTracker: StderrTracker;

  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  constructor(options: ProcessorOptions = {}) {
    super();
    this.config = buildProcessorConfig(options);
    this.extraGlobalArgs = [...this.config.extraGlobalArgs];
    this.useAudioProcessor = !!options.useAudioProcessor;
    this.currentVolume = this.config.audioProcessorOptions?.volume ?? 1;
    this.currentBass = this.config.audioProcessorOptions?.bass ?? 0;
    this.currentTreble = this.config.audioProcessorOptions?.treble ?? 0;
    this.currentCompressor =
      this.config.audioProcessorOptions?.compressor ?? false;

    this.stderrTracker = new StderrTracker(this.config, {
      onProgress: (progress) => this.emit("progress", progress),
      onBitrateDetected: (kbps) => {
        if (this.throttledOutput) {
          updateThrottleBitrate(this.throttledOutput, kbps);
        }
      },
    });

    this._handleAbortSignal();
  }

  public setArgs(args: string[]): this {
    this.args = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public getArgs(): string[] {
    return [...this.args];
  }

  public setInputStreams(
    streams: Array<{ stream: ReadableStream<Uint8Array>; index: number }>,
  ): this {
    const validStreams = Array.isArray(streams) ? [...streams] : [];

    if (validStreams.length > 1) {
      throw new Error(
        "[fluent-streamer] FFmpeg supports only a single ReadableStream via standard input (pipe:0). " +
          "Multiple stream inputs are not supported in cross-runtime environments.",
      );
    }

    this.inputStreams = validStreams;
    return this;
  }

  public getInputStream(): WritableStream<Uint8Array> | undefined {
    return this.process?.stdin ?? undefined;
  }

  public setExtraOutputStreams(
    streams: Array<{ stream: WritableStream<Uint8Array>; index: number }>,
  ): this {
    this.extraOutputs = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  public setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public setInputSources(sources: InputSource[]): this {
    this.config.inputSources = Array.isArray(sources) ? [...sources] : [];
    return this;
  }

  public getFullArgs(): string[] {
    return buildFullArgs(this.config, this.extraGlobalArgs, this.args);
  }

  public enableAudioProcessor(enable: boolean): this {
    this.useAudioProcessor = enable;
    return this;
  }

  public isRunning(): boolean {
    return !!this.process && !this.hasFinished;
  }

  public getProgress() {
    return this.stderrTracker.getProgress();
  }

  public reset(): void {
    this._resetRunState();
  }

  public async run(): Promise<FFmpegRunResultExtended> {
    if (this.process) throw new Error("FFmpeg process is already running");
    if (this._skipInProgress) throw new Error("Skip operation in progress");

    this._resetRunState();
    this._initPromise();
    this.processState = "running";
    this._startTime = Date.now();
    this._totalChunks = 0;

    await this._resolveBlobSources();
    this.config.ffmpegPath = await resolveFfmpegPath(this.config.ffmpegPath);

    const fullArgs = this.getFullArgs();
    this._executeBeforeSpawnHook(fullArgs);
    this._logSpawnDetails(fullArgs);

    try {
      const runner = await ffmpegManager.ensure();
      this.process = runner.spawn(this.config.ffmpegPath, fullArgs);
    } catch (ex) {
      this.config.logger.error?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`,
      );
      this._finalize(ex as Error, "failed");
      throw ex;
    }

    this.process.onError?.((error) => {
      if (this.hasFinished) return;
      this.emit("error", error);
      this._finalize(error, "failed");
    });

    this._handleTimeout();

    pipeInputStreams(this.process, this.inputStreams, {
      onError: (err) => {
        this.emit("error", err);
        this._finalize(err, "failed");
      },
      hasFinished: () => this.hasFinished,
      isTerminating: () => this.isTerminating,
    });

    const outputTransformStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });

    const audioProcessor = createAudioProcessor(
      this.config,
      this.useAudioProcessor,
      this.currentVolume,
      this.currentBass,
      this.currentTreble,
      this.currentCompressor,
    );

    const { throttledOutput, pipelinePromise } = setupOutputPipeline(
      this.process,
      audioProcessor,
      outputTransformStream,
      {
        disableThrottling: this.config.disableThrottling,
        verbose: this.config.verbose,
        loggerTag: this.config.loggerTag,
        logger: this.config.logger,
        sampleRate: this.config.audioProcessorOptions?.sampleRate,
        channels: this.config.audioProcessorOptions?.channels,
      },
      {
        onError: (err) => {
          this.emit("error", err);
          this._finalize(err, "failed");
        },
        onPipelineComplete: () => {
          this._runEnded = true;
        },
        hasFinished: () => this.hasFinished,
      },
    );

    this.throttledOutput = throttledOutput;
    this._pipelinePromise = pipelinePromise;
    this.outputStream = outputTransformStream.readable;
    if (this.config.autoDrainOutput) {
      ensureOutputDrained(outputTransformStream.readable);
    }
    this._startStderrReader();

    this.process.onExit((code, signal) => {
      this._pendingProcessExitLog = () => {
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`,
          );
        }
      };
      this._onProcessExit(code, signal);
    });

    this._setupEndSequence();

    this.donePromise!.catch((err) => {
      this.emit("error", err);
    });

    const controller = new AudioEffectController(audioProcessor, this.config, {
      volume: this.currentVolume,
      bass: this.currentBass,
      treble: this.currentTreble,
      compressor: this.currentCompressor,
      normalize: this.currentNormalize ?? false,
    });

    return {
      output: outputTransformStream.readable,
      passthrough: outputTransformStream.readable,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
      audioProcessor,
      setVolume: (v) => controller.setVolume(v),
      setBass: (b) => controller.setBass(b),
      setTreble: (t) => controller.setTreble(t),
      setCompressor: (c) => controller.setCompressor(c),
      setNormalize: (n) => controller.setNormalize(n),
      startFade: (tv, dur) => controller.startFade(tv, dur),
    };
  }

  public async close(): Promise<void> {
    if (this.isClosed || this.processState === "closed") return;
    this.isClosed = true;
    this.terminationReason = "close";
    if (this.processState === "running") this.processState = "terminating";
    this._runEmittedEnd = true;
    this.outputStream = null;

    if (this.config.verbose) {
      this.config.logger.debug?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Closed processor stream via .close()`,
      );
    }

    await this.kill();
    await this.donePromise;
  }

  public async kill(signal: string = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      this.terminationReason ??= "user";
      if (this.processState === "running") this.processState = "terminating";
      this._skipInProgress = true;

      if (this.config.verbose) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Killing process with signal ${signal}`,
        );
      }

      try {
        if (this.throttledOutput && !this.throttledOutput.readable.locked) {
          try {
            await this.throttledOutput.readable.cancel();
          } catch {}
        }

        if (this.outputStream && !this.outputStream.locked) {
          try {
            await this.outputStream.cancel();
          } catch {}
        }

        this.process.kill(signal);
      } catch (error) {
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Kill error: ${error}`,
          );
        }
      }

      if (this.donePromise) {
        try {
          await this.donePromise;
        } catch (err) {
          if (this.config.verbose) {
            this.config.logger.debug?.(
              `[${getTimeString()}] [${this.config.loggerTag}] donePromise rejected during kill: ${err}`,
            );
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      this._skipInProgress = false;
    }
  }

  public async skip(): Promise<void> {
    const now = Date.now();
    if (now - this._lastSkipTime < this.SKIP_DEBOUNCE_MS) {
      if (this.config.verbose) {
        this.config.logger.warn?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Skip ignored: too soon after previous skip`,
        );
      }
      return;
    }

    this._lastSkipTime = now;
    await this.kill("SIGTERM");
  }

  public destroy(): void {
    if (this.config.verbose) {
      this.config.logger?.warn?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Processor force destroy() called`,
      );
    }
    this.terminationReason = "destroy";
    this._cleanup();
    void this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"), "failed");
    this.removeAllListeners();
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
    return createSilenceMs(
      durationMs,
      sampleRate,
      channels,
      this.stderrTracker.getBitrate(),
    );
  }

  public createSilenceBuffer(
    durationMs = 100,
    sampleRate = 48000,
    channels = 2,
  ) {
    return createSilenceBuffer(durationMs, sampleRate, channels);
  }

  public static buildAcrossfadeFilter = buildAcrossfadeFilter;

  public toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  public debugDump(): ProcessorDebugInfo {
    return {
      pid: this.pid,
      args: this.getArgs(),
      fullArgs: this.getFullArgs(),
      isClosed: this.isClosed,
      hasFinished: this.hasFinished,
      isTerminating: this.isTerminating,
      state: this.processState,
      running: !!this.process,
      runEnded: this._runEnded,
      runEmittedEnd: this._runEmittedEnd,
      extraGlobalArgs: [...this.extraGlobalArgs],
      stderrBufferLength: this.stderrTracker.getBuffer().length,
      timeoutHandle: !!this.timeoutHandle,
      progress: this.stderrTracker.getProgress(),
      inputStreamsCount: this.inputStreams.length,
      extraOutputsCount: this.extraOutputs.length,
      timestamp: new Date().toISOString(),
    };
  }

  public static create(
    params?: {
      args?: string[];
      inputStreams?: Array<{
        stream: ReadableStream<Uint8Array>;
        index: number;
      }>;
      options?: ProcessorOptions;
    } & Partial<ProcessorOptions>,
  ): Processor {
    if (!params || typeof params !== "object") return new Processor();

    const {
      options: extraOptions,
      args: workerArgs,
      inputStreams: workerInputStreams,
      ...restParams
    } = params;
    const optionsObj = {
      ...(typeof extraOptions === "object" ? extraOptions : {}),
      ...restParams,
    };
    const worker = new Processor(optionsObj);

    if (workerArgs) worker.setArgs(workerArgs);
    if (workerInputStreams) worker.setInputStreams(workerInputStreams);

    return worker;
  }

  private async _resolveBlobSources(): Promise<void> {
    const blobPromises: Promise<void>[] = [];
    for (const source of this.config.inputSources) {
      if (source.type === "blob") {
        const promise = resolveBlobToStream(source.blobUrl, {
          verbose: this.config.verbose,
          loggerTag: this.config.loggerTag,
          logger: this.config.logger,
        }).then((stream) => {
          this.inputStreams.push({ stream, index: source.index });
        });
        blobPromises.push(promise);
      }
    }
    await Promise.all(blobPromises);
  }

  private _executeBeforeSpawnHook(fullArgs: string[]): void {
    if (!this.config.onBeforeChildProcessSpawn) return;
    try {
      this.config.onBeforeChildProcessSpawn(this.config.ffmpegPath, fullArgs);
    } catch {
      //
    }
  }

  private _logSpawnDetails(fullArgs: string[]): void {
    if (!this.config.verbose) return;

    this.config.logger.info?.(
      `[${getTimeString()}] [${this.config.loggerTag}] FFmpeg command: ${this.config.ffmpegPath} ${fullArgs.join(" ")}`,
    );
    this.config.logger.info?.(
      `[${getTimeString()}] [${this.config.loggerTag}] Audio config: volume=${this.currentVolume}, bass=${this.currentBass}dB, treble=${this.currentTreble}dB, compressor=${this.currentCompressor}`,
    );
  }

  private _setupEndSequence(): void {
    this.endSequenceFn = () => {
      if (this._runEmittedEnd || this.hasFinished || this.isClosed) return;
      this._runEmittedEnd = true;

      const finalizeAfterDelay = () => {
        setTimeout(() => {
          this.emit("end");
          if (this._pendingProcessExitLog) {
            this._pendingProcessExitLog();
            this._pendingProcessExitLog = null;
          }
          this._finalize();
        }, 100);
      };

      if (this._pipelinePromise) {
        this._pipelinePromise
          .then(finalizeAfterDelay)
          .catch(() => finalizeAfterDelay());
      } else {
        finalizeAfterDelay();
      }
    };
  }

  private _initPromise(): void {
    this.donePromise = new Promise((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  private _resetRunState(): void {
    this._runEnded = false;
    this._runEmittedEnd = false;
    this._pendingProcessExitLog = null;
    this.processState = "idle";
    this.terminationReason = null;
    this.isClosed = false;
    this.hasFinished = false;
    this.doneSettled = false;
    this.isTerminating = false;
    this.stderrTracker.reset();
    this.process = null;
    this.outputStream = null;
    this.endSequenceFn = null;
    this.throttledOutput = null;
    this._startTime = 0;
    this._totalChunks = 0;
    this._skipInProgress = false;
    this._lastSkipTime = 0;

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
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
    if (!this.config.timeout) return;

    this.timeoutHandle = setTimeout(() => {
      if (this.config.verbose) {
        this.config.logger.warn?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`,
        );
      }
      this.terminationReason = "timeout";
      if (this.processState === "running") this.processState = "terminating";
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  private _startStderrReader(): void {
    if (!this.process?.stderr) return;

    void readStderrStream(
      this.process.stderr,
      (chunk) => this.stderrTracker.handleChunk(chunk),
      (text) => this.config.stderrLogHandler?.(text),
      (err) => {
        this.emit("error", err);
        this._finalize(err, "failed");
      },
    );
  }

  private _onProcessExit(code: number | null, signal: string | null): void {
    if (this.hasFinished) return;

    const isUserTermination =
      this.isTerminating &&
      (this.terminationReason === "user" ||
        this.terminationReason === "close" ||
        this.terminationReason === "destroy");
    const isTimeout = this.terminationReason === "timeout";
    const exitedCleanly = code === 0 && signal === null;

    if (!isTimeout && (exitedCleanly || isUserTermination)) {
      if (this.isTerminating) {
        setTimeout(() => {
          this.emit("terminated", signal ?? "SIGTERM");
        }, 50);
      }

      if (this.config.debug) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process exited normally with code ${code}, signal ${signal}`,
        );
      }

      if (!this._runEmittedEnd) {
        this._runEnded = true;
        setTimeout(() => {
          if (this.endSequenceFn && !this._runEmittedEnd) {
            this.endSequenceFn();
          }
        }, 0);
      } else {
        this._finalize(
          undefined,
          this.terminationReason === "close" ? "closed" : "finished",
        );
      }
    } else {
      const error = isTimeout
        ? new Error(`FFmpeg process timed out after ${this.config.timeout}ms`)
        : buildProcessExitError(code, signal, this.stderrTracker.getBuffer());
      const tail = this.stderrTracker.getBuffer().trim().slice(-4000);

      if (tail && this.config.verbose) {
        this.config.logger.error?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`,
        );
      }

      this.emit("error", error);
      this._finalize(error, "failed");
    }
  }

  private _finalize(error?: Error, finalState?: ProcessorState): void {
    if (this.hasFinished) return;
    this.hasFinished = true;
    if (finalState) {
      this.processState = finalState;
    } else if (this.isClosed || this.terminationReason === "close") {
      this.processState = "closed";
    } else if (error) {
      this.processState = "failed";
    } else {
      this.processState = "finished";
    }

    try {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);

      if (this.config.verbose) {
        const duration = (Date.now() - this._startTime) / 1000;
        const expectedDuration = this.stderrTracker.getDuration() || 0;
        const ratio = expectedDuration > 0 ? duration / expectedDuration : 0;

        this.config.logger.info?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Playback complete: ` +
            `actual=${duration.toFixed(1)}s, expected=${expectedDuration.toFixed(1)}s, ` +
            `ratio=${ratio.toFixed(2)}, chunks=${this._totalChunks}`,
        );
      }

      this._cleanup();

      if (this.outputStream && !this.outputStream.locked) {
        this.emit("end");
      }

      this._settleDone(error);
    } finally {
      this.process = null;
      this.outputStream = null;
      this.timeoutHandle = undefined;
    }
  }

  private _settleDone(error?: Error): void {
    if (this.doneSettled) return;
    this.doneSettled = true;

    if (error) {
      this.doneReject(error);
    } else {
      this.doneResolve();
    }
  }

  private _cleanup(): void {
    try {
      if (this.process) {
        try {
          this.process.kill("SIGKILL");
        } catch {
          //
        }
        this.process = null;
      }
      this.outputStream = null;
      this.throttledOutput = null;
      this._pipelinePromise = null;
      this.endSequenceFn = null;
    } catch {
      //
    }

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }
}

export default Processor;
