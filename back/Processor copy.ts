// Processor.ts
import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline as pipelineCb, Transform } from "stream";
import { pipeline } from "stream/promises";
import { execa, type Subprocess } from "execa";
import type {
  Logger,
  FFmpegProgress,
  FFmpegRunResultExtended,
  AudioProcessingOptions,
} from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";

/** Escape ffmpeg param special chars */
function escapeParam(val: string | number | undefined): string | number | undefined {
  if (typeof val !== "string") return val;
  return val.replace(/[:=]/g, (m) => "\\" + m);
}

type DrainAttachedStream = PassThrough & { _ffmpegDrainAttached?: boolean };

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
    audioProcessorOptions?: AudioProcessingOptions;
    useAudioProcessor?: boolean;
  };

  private args: string[] = [];
  private extraGlobalArgs: string[] = [];

  public audioProcessor: AudioProcessor | null = null;
  private audioProcessorOptions?: AudioProcessingOptions;

  private _runEnded = false;
  private _runEmittedEnd = false;
  private _doEndSequence: (() => void) | null = null;
  private _pendingProcessExitLog: (() => void) | null = null;
  private _passthroughEnded = false;
  private _processExited = false;
  private _outputStreamEnded = false;
  private _audioProcessorEnded = false;

  constructor(options: ProcessorOptions = {}, audioProcessingOptions?: AudioProcessingOptions) {
    super();

    // Исправление: копирование опций с контролем значений
    const apOpts: AudioProcessingOptions = Object.assign(
      {},
      {
        volume: 1,
        bass: 0,
        treble: 0,
        compressor: false,
        normalize: false,
        headers: {},
        lowPassFrequency: undefined,
        lowPassQ: undefined,
        fade: undefined,
      },
      options.audioProcessorOptions ?? {},
      audioProcessingOptions ?? {}
    );

    this.audioProcessorOptions = apOpts;

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
      verbose: options.verbose ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
      audioProcessorOptions: this.audioProcessorOptions!,
      useAudioProcessor: Boolean(options.useAudioProcessor),
    };

    this.extraGlobalArgs = Array.isArray(this.config.extraGlobalArgs)
      ? [...this.config.extraGlobalArgs]
      : [];

    this._initPromise();
    this._handleAbortSignal();
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
  public isRunning(): boolean {
    return !!this.process && !this.hasFinished;
  }
  public getProgress(): Partial<FFmpegProgress> {
    return { ...this.progress };
  }
  public reset(): void {
    if (this.audioProcessor) {
      try {
        this.audioProcessor.destroy();
      } catch (e) {}
    }
    this._resetRunState();
  }

  public run(): FFmpegRunResultExtended {
    if (this.process) throw new Error("FFmpeg process is already running");

    this._resetRunState();
    this._initPromise();
    this._outputStreamEnded = false;
    this._audioProcessorEnded = false;

    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Starting ffmpeg: ${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`
      );
    }

    const fullArgs = this.getFullArgs();

    try {
      this.process = execa(this.config.ffmpegPath, fullArgs, {
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (ex) {
      this.config.logger.error?.(
        `[${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`
      );
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();
    this._bindInputStream();

    const output = new PassThrough();
    this.outputStream = output;
    this.passthrough = new PassThrough();
    this._passthroughEnded = false;

    let processingStream: Transform | PassThrough = output;
    let handleAudioProcessorEnd = () => {};

    // pipe ffmpeg stdout to our output
    if (this.process.stdout) {
      (this.process.stdout as Readable)
        .on("error", (err) => {
          this.emit("error", err);
        })
        .pipe(output);

      output.on("end", () => {
        this._outputStreamEnded = true;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${this.config.loggerTag}] outputStream (ffmpeg stdout PassThrough) ended`);
        }
      });

      if (this.extraOutputs.length) {
        for (const { stream } of this.extraOutputs) {
          pipelineCb(output, stream, (err: Error | null | undefined) => {
            if (err && !/premature close/i.test(err.message)) this.emit("error", err);
          });
        }
      }
    }

    if (this.config.useAudioProcessor && this.config.audioProcessorOptions) {
      try {
        this.audioProcessor = new AudioProcessor(this.config.audioProcessorOptions);
        this.emit("audioprocessor-ready", this.audioProcessor);

        this.audioProcessor.on("error", (err) => {
          this.config.logger.error?.(
            `[${this.config.loggerTag}] AudioProcessor error: ${err instanceof Error ? err.stack || err.message : err}`
          );
          this.emit("error", err);
          this.finalizePassthrough(err as Error);
          this._finalize(err as Error);
        });

        this.audioProcessor.on("end", () => {
          this._audioProcessorEnded = true;
          if (this.config.debug || this.config.verbose) {
            this.config.logger.debug?.(`[${this.config.loggerTag}] AudioProcessor ended`);
          }
        });
        this.audioProcessor.on("close", () => {
          if (this.config.debug || this.config.verbose) {
            this.config.logger.debug?.(`[${this.config.loggerTag}] AudioProcessor closed`);
          }
        });

        handleAudioProcessorEnd = () => {
          this._audioProcessorEnded = true;
        };

        output
          .pipe(this.audioProcessor)
          .on("data", (chunk: Buffer) => {
            if (!this.passthrough) return;
            if (!this._passthroughEnded && !this.passthrough.destroyed && !this.passthrough.readableEnded) {
              const ok = this.passthrough.write(chunk);
              if (!ok) {
                try {
                  output.pause?.();
                } catch {}
                this.passthrough.once("drain", () => {
                  try {
                    output.resume?.();
                  } catch {}
                });
              }
            }
          })
          .once("end", () => {
            handleAudioProcessorEnd();
            if (this.config.debug || this.config.verbose) {
              this.config.logger.debug?.(`[${this.config.loggerTag}] AudioProcessor stream emitted 'end'`);
            }
            this.finalizePassthrough();
          })
          .once("error", (err: Error) => {
            handleAudioProcessorEnd();
            this.finalizePassthrough(err);
          })
          .once("close", () => {
            handleAudioProcessorEnd();
            this.finalizePassthrough();
          });

        processingStream = this.audioProcessor;
      } catch (err) {
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Failed to init AudioProcessor: ${(err as Error).message}`
        );
        output.on("data", (chunk: Buffer) => {
          if (!this.passthrough) return;
          if (!this._passthroughEnded && !this.passthrough.destroyed && !this.passthrough.readableEnded) {
            this.passthrough.write(chunk);
          }
        });
      }
    } else {
      output.on("data", (chunk: Buffer) => {
        if (!this.passthrough) return;
        if (!this._passthroughEnded && !this.passthrough.destroyed && !this.passthrough.readableEnded) {
          const ok = this.passthrough.write(chunk);
          if (!ok) {
            try { output.pause?.(); } catch {}
            this.passthrough.once("drain", () => { try { output.resume?.(); } catch {} });
          }
        }
      });
      output.on("end", () => {
        this._outputStreamEnded = true;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${this.config.loggerTag}] outputStream (no AudioProcessor) ended`);
        }
        this.finalizePassthrough();
      });
    }

    this._ensureOutputDrained();

    if (this.process.stderr) {
      this.process.stderr.on("data", (chunk) => this._handleStderr(chunk));
    }

    this.process.once("exit", (code, signal) => {
      this._pendingProcessExitLog = () => {
        this.config.logger.info?.(
          `[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal} at ${new Date().toISOString()}`
        );
      };
      this._onProcessExit(code, signal);
    });

    this.process.once("error", (err: Error) => {
      this.config.logger.error?.(`[${this.config.loggerTag}] Process error: ${err.message}`);
      this.emit("error", err);
      this.finalizePassthrough(err);
      this._finalize(err);
    });

    let finalized = false;
    const safeFinalize = (err?: Error) => {
      if (finalized) return;
      finalized = true;
      this.finalizePassthrough(err);
      if (err) this._finalize(err); else this._finalize();
    };

    processingStream.on("end", () => {
      this._runEnded = true;
      if (this._doEndSequence && !this._runEmittedEnd) this._doEndSequence();
    });

    processingStream.on("close", () => {
      if (!this._runEnded && this._doEndSequence && !this._runEmittedEnd) {
        this._runEnded = true;
        setImmediate(() => {
          if (this._doEndSequence && !this._runEmittedEnd) this._doEndSequence();
        });
      }
    });

    const canEndPassthrough = (): boolean => {
      if (this.config.useAudioProcessor && this.audioProcessor) {
        return this._outputStreamEnded && this._audioProcessorEnded;
      }
      return this._outputStreamEnded;
    };

    this._doEndSequence = () => {
      if (this._runEmittedEnd) return;
      if (this.hasFinished || this.isClosed) return;

      if (
        this._passthroughEnded ||
        !this.passthrough ||
        this.passthrough.destroyed ||
        this.passthrough.readableEnded
      ) {
        setImmediate(() => {
          this.emit("end");
          if (this._pendingProcessExitLog) {
            this._pendingProcessExitLog();
            this._pendingProcessExitLog = null;
          }
          safeFinalize();
        });
        return;
      }

      if (!canEndPassthrough()) {
        const tryEndLate = () => {
          if (canEndPassthrough() && !this._runEmittedEnd) {
            this._runEmittedEnd = true;
            try {
              if (
                !this.hasFinished &&
                !this.isClosed &&
                this.passthrough &&
                !this.passthrough.destroyed &&
                !this.passthrough.readableEnded &&
                !this._passthroughEnded
              ) {
                const buffer = this.createSilenceBuffer(100);
                const finalize = () => safeFinalize();
                const written = this.passthrough.write(buffer);
                if (!written) this.passthrough.once("drain", finalize);
                else setImmediate(finalize);
              } else {
                setImmediate(() => safeFinalize());
              }
            } catch {
              setImmediate(() => safeFinalize());
            }
            this.emit("end");
            if (this._pendingProcessExitLog) {
              this._pendingProcessExitLog();
              this._pendingProcessExitLog = null;
            }
          }
        };
        const maybeEmitEnd = () => { tryEndLate(); };
        if (this.config.useAudioProcessor && this.audioProcessor) {
          if (!this._outputStreamEnded) output.once("end", maybeEmitEnd);
          if (!this._audioProcessorEnded) this.audioProcessor.once("end", maybeEmitEnd);
        } else {
          if (!this._outputStreamEnded) output.once("end", maybeEmitEnd);
        }
        return;
      }

      this._runEmittedEnd = true;
      try {
        if (
          !this.hasFinished &&
          !this.isClosed &&
          this.passthrough &&
          !this.passthrough.destroyed &&
          !this.passthrough.readableEnded &&
          !this._passthroughEnded
        ) {
          const buffer = this.createSilenceBuffer(100);
          const finalize = () => safeFinalize();
          const written = this.passthrough.write(buffer);
          if (!written) this.passthrough.once("drain", finalize);
          else setImmediate(finalize);
        } else {
          setImmediate(() => safeFinalize());
        }
      } catch {
        setImmediate(() => safeFinalize());
      }
      this.emit("end");
      if (this._pendingProcessExitLog) {
        this._pendingProcessExitLog();
        this._pendingProcessExitLog = null;
      }
    };

    this.donePromise!.catch((err) => {
      this.emit("error", err);
      this.finalizePassthrough(err);
    });

    return {
      output: this.passthrough!,
      passthrough: this.passthrough!,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
      audioProcessor: this.audioProcessor ?? undefined,
      setVolume: this.setVolume.bind(this),
      startFade: this.startFade.bind(this),
      setBass: this.setBass.bind(this),
      setTreble: this.setTreble.bind(this),
      setCompressor: this.setCompressor.bind(this),
      setEqualizer: this.setEqualizer.bind(this),
    } as unknown as FFmpegRunResultExtended;
  }

  // DOUBLE-END PROTECTION: Do not end passthrough multiple times even if error/stream finish races happen.
  private finalizePassthrough(err?: Error): void {
    if (this._passthroughEnded) return;
    this._passthroughEnded = true;
    if (this.passthrough) {
      // Don't attempt to write 'end' if already destroyed
      if (err) {
        if (!this.passthrough.destroyed && !this.passthrough.writableEnded) {
          this.passthrough.destroy(err);
        }
      } else {
        if (!this.passthrough.destroyed && !this.passthrough.writableEnded) {
          this.passthrough.end();
        }
      }
    }
  }

  public startFade(targetVolume: number, durationMs: number): void {
    this._ensureAudioProcessor();
    this.audioProcessor.startFade(targetVolume, durationMs);
  }
  public setVolume(volume: number): void {
    this._ensureAudioProcessor();
    this.audioProcessor.setVolume(volume);
  }
  public setBass(bass: number): void {
    this._ensureAudioProcessor();
    this.audioProcessor.setEqualizer(bass, this.getTreble(), this.getCompressor());
  }
  public setTreble(treble: number): void {
    this._ensureAudioProcessor();
    this.audioProcessor.setEqualizer(this.getBass(), treble, this.getCompressor());
  }
  public setCompressor(enabled: boolean): void {
    this._ensureAudioProcessor();
    this.audioProcessor.setCompressor(enabled);
  }
  public setEqualizer(bass: number, treble: number, compressor: boolean): void {
    this._ensureAudioProcessor();
    this.audioProcessor.setEqualizer(bass, treble, compressor);
  }
  public getBass(): number {
    this._ensureAudioProcessor();
    return this.audioProcessor.bass;
  }
  public getTreble(): number {
    this._ensureAudioProcessor();
    return this.audioProcessor.treble;
  }
  public getCompressor(): boolean {
    this._ensureAudioProcessor();
    return this.audioProcessor.compressor;
  }
  public getVolume(): number {
    this._ensureAudioProcessor();
    return this.audioProcessor.volume;
  }
  private _ensureAudioProcessor(): asserts this is this & { audioProcessor: AudioProcessor } {
    if (!this.audioProcessor) throw new Error("AudioProcessor is not initialized or active");
  }

  public configureAudioProcessor(opts?: AudioProcessingOptions | false): this {
    if (opts === false) {
      this.config.useAudioProcessor = false;
      this.audioProcessorOptions = undefined;
    } else if (typeof opts === "object") {
      this.config.useAudioProcessor = true;
      this.config.audioProcessorOptions = { ...opts };
      this.audioProcessorOptions = { ...opts };
    }
    return this;
  }

  /**
   * Замена AudioProcessor:
   * Если _passthroughEnded=true (пайплайн завершен), данные не будут проходить новым AudioProcessor.
   * Это ожидаемое поведение: нельзя заменить процессор "на лету" после окончания, перезапустите run().
   */
  public replaceAudioProcessor(options: AudioProcessingOptions): this {
    if (!this.config.useAudioProcessor) throw new Error("AudioProcessor not active");

    if (this._passthroughEnded) {
      this.config.logger.warn?.(`[${this.config.loggerTag}] Attempted to replace AudioProcessor after passthrough ended - no effect.`);
      return this;
    }

    try {
      if (this.outputStream && this.audioProcessor) {
        try { this.outputStream.unpipe(this.audioProcessor); } catch {}
        try { this.audioProcessor.end(); } catch {}
      }
    } catch {}
    try { this.audioProcessor?.destroy(); } catch {}

    this.audioProcessor = new AudioProcessor(options);

    this.audioProcessor.on("error", (err) => {
      this.config.logger.error?.(
        `[${this.config.loggerTag}] AudioProcessor error: ${err instanceof Error ? err.stack || err.message : err}`
      );
      this.emit("error", err);
      this.finalizePassthrough(err as Error);
      this._finalize(err as Error);
    });
    this.audioProcessor.on("end", () => {
      this._audioProcessorEnded = true;
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${this.config.loggerTag}] AudioProcessor (replace) ended`);
      }
    });

    if (this.outputStream && this.passthrough && !this._passthroughEnded) {
      try {
        (this.outputStream as Readable).pause?.();
        (this.outputStream as Readable).pipe(this.audioProcessor)
          .on("data", (chunk: Buffer) => {
            if (!this.passthrough) return;
            if (!this._passthroughEnded && !this.passthrough.destroyed && !this.passthrough.readableEnded) {
              this.passthrough.write(chunk);
            }
          })
          .once("end", () => {
            this._audioProcessorEnded = true;
            this.finalizePassthrough();
          })
          .once("error", (err: Error) => {
            this._audioProcessorEnded = true;
            this.finalizePassthrough(err);
          })
          .once("close", () => {
            this._audioProcessorEnded = true;
            this.finalizePassthrough();
          });
        (this.outputStream as Readable).resume?.();
      } catch {
        (this.outputStream as Readable).on("data", (chunk: Buffer) => {
          if (!this.passthrough) return;
          if (!this._passthroughEnded && !this.passthrough.destroyed && !this.passthrough.readableEnded) {
            this.passthrough.write(chunk);
          }
        });
      }
    }

    this.config.audioProcessorOptions = { ...options };
    this.audioProcessorOptions = { ...options };
    this.emit("audioprocessor-ready", this.audioProcessor);

    return this;
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this._runEmittedEnd = true;
    if (this.audioProcessor && !this.audioProcessor.destroyed) {
      try { this.audioProcessor.destroy(); } catch {}
    }
    this.finalizePassthrough();
    this.outputStream?.destroy();
    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(`[${this.config.loggerTag}] Closed processor via .close()`);
    }
    await this.kill();
    if (this.donePromise) {
      try { await this.donePromise; } catch {}
    }
    this._finalize();
  }

  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${this.config.loggerTag}] Killing process with ${signal}`);
      }
      try { this.process.kill(signal); } catch {}
    }
    if (this.audioProcessor && !this.audioProcessor.destroyed) {
      try { this.audioProcessor.destroy(); } catch {}
    }
    if (this.donePromise) {
      try { await this.donePromise; } catch {}
    }
  }

  public async destroy(): Promise<void> {
    this.config.logger?.warn?.(`[${this.config.loggerTag}] Processor force destroy() called at ${new Date().toISOString()}`);
    await this.kill("SIGKILL");
    if (this.audioProcessor && !this.audioProcessor.destroyed) {
      try { this.audioProcessor.destroy(); } catch {}
    }
    this.finalizePassthrough(new Error("Destroyed by user"));
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
      audioProcessor: Boolean(this.audioProcessor),
      useAudioProcessor: this.config.useAudioProcessor,
      audioProcessorOptions: this.config.audioProcessorOptions,
      timestamp: new Date().toISOString(),
    };
  }

  private _initPromise() {
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  private _resetRunState() {
    if (this.outputStream && (this.outputStream as DrainAttachedStream)._ffmpegDrainAttached) {
      delete (this.outputStream as DrainAttachedStream)._ffmpegDrainAttached;
    }

    this._runEnded = false;
    this._runEmittedEnd = false;
    this._pendingProcessExitLog = null;
    this.isClosed = false;
    this.hasFinished = false;
    this.isTerminating = false;
    this.stderrBuffer = "";
    this.progress = {};
    if (this.process) {
      try { this.process.kill("SIGKILL"); } catch {}
    }
    this.process = null;
    this.outputStream = null;
    this.passthrough = null;
    this.blackholeStream = null;
    this._passthroughEnded = false;
    this._processExited = false;
    this._outputStreamEnded = false;
    this._audioProcessorEnded = false;
    if (this.audioProcessor) {
      try { this.audioProcessor.destroy(); } catch {}
      this.audioProcessor = null;
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private _getBlackholeStream(): Writable {
    if (this.blackholeStream) return this.blackholeStream;
    this.blackholeStream = new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
    return this.blackholeStream;
  }

  private _ensureOutputDrained() {
    const output = this.outputStream as DrainAttachedStream | null;
    if (!output) return;
    if (output._ffmpegDrainAttached) return;

    let actuallyRead = false;
    const markRead = () => {
      actuallyRead = true;
      output._ffmpegDrainAttached = true;
    };

    const events = ["data", "readable", "end", "close"];
    let timer: NodeJS.Timeout | undefined;
    const isBeingRead = () => {
      const listeners = output.listeners?.("data") ?? [];
      return listeners.length > 1;
    };

    const maybeDrain = () => {
      if (!actuallyRead && output && !output._ffmpegDrainAttached && !isBeingRead()) {
        output._ffmpegDrainAttached = true;
        output.pipe(this._getBlackholeStream());
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${this.config.loggerTag}] Output PassThrough drained to blackhole to prevent Broken pipe`
          );
        }
      }
    };

    events.forEach((ev) => output.once(ev, markRead));
    output.once("newListener", (event: string) => {
      if (events.includes(event)) {
        markRead();
        if (timer) clearTimeout(timer);
      }
    });
    timer = setTimeout(maybeDrain, 250);
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
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
      this.config.logger.warn?.(
        `[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`
      );
      this.kill("SIGKILL").finally(() => {
        setTimeout(() => {
          if (!this.hasFinished) this._finalize(new Error("Process timeout exceeded"));
        }, 2500);
      });
    }, this.config.timeout);
  }

  private async _bindInputStream(): Promise<void> {
    if (!this.inputStreams.length || !this.process?.stdin) return;
    for (const { stream, index } of this.inputStreams) {
      if (!stream) continue;
      stream.on("error", (err) => {
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Input stream error [index=${index}]: ${(err as Error).message}`
        );
        this.emit("error", err);
        this._finalize(err as Error);
      });

      stream.on("end", () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${this.config.loggerTag}] Input stream ended [index=${index}]`);
        }
      });

      if (index === 0) {
        void pipeline(stream, this.process.stdin).catch((err: Error) => {
          if ((err as NodeJS.ErrnoException).code === "EPIPE" && (this.hasFinished || this.isTerminating)) {
            return;
          }
          this.config.logger.error?.(`[${this.config.loggerTag}] Input pipeline failed [index=0]: ${(err as Error).message}`);
          this.emit("error", err);
          this._finalize(err as Error);
        });
      } else {
        void pipeline(stream, this._getBlackholeStream()).catch(() => {});
      }
    }
  }

  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
        this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - this.config.maxStderrBuffer);
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

  private _onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this._processExited) return;
    this._processExited = true;
    if (this.isTerminating && signal) {
      this.emit("terminated", signal ?? "SIGTERM");
    }
    this.config.logger.info?.(
      `[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal} at ${new Date().toISOString()}`
    );
    if (
      code === 0 ||
      (signal !== null && this.isTerminating) ||
      ((signal === "SIGKILL" || signal === "SIGTERM") && this.hasFinished)
    ) {
      if (!this._runEmittedEnd) {
        this._runEnded = true;
        setImmediate(() => this._doEndSequence && !this._runEmittedEnd && this._doEndSequence());
      }
    } else {
      const error = this._getProcessExitError(code, signal);
      const tail = this.stderrBuffer.trim().slice(-4000);
      if (tail && (this.config.debug || this.config.verbose)) {
        this.config.logger.error?.(`[${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`);
      }
      this.emit("error", error);
      this.finalizePassthrough(error);
      this._finalize(error);
    }
  }

  private _getProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
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
    try {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      this._cleanup();
      if (error) this.doneReject(error);
      else this.doneResolve();
    } finally {
      this.process = null;
      this.outputStream = null;
      this.passthrough = null;
      this.blackholeStream = null;
      this.timeoutHandle = undefined;
      if (this.audioProcessor) {
        try { this.audioProcessor.destroy(); } catch {}
      }
      this.donePromise = null;
      this._passthroughEnded = true;
      this._outputStreamEnded = true;
      this._audioProcessorEnded = true;
    }
  }

  private _cleanup(): void {
    try {
      this.process?.removeAllListeners();
      this.process?.stdin?.removeAllListeners();
      this.process?.stdout?.removeAllListeners();
      this.process?.stderr?.removeAllListeners();
      this.outputStream?.destroy();
      if (this.passthrough && !this._passthroughEnded) {
        try { this.passthrough.end(); } catch {}
        try { this.passthrough.destroy(); } catch {}
        this._passthroughEnded = true;
      }
      this.blackholeStream?.destroy();
      if (this.audioProcessor) {
        try { this.audioProcessor.destroy(); } catch {}
      }
      for (const { stream } of this.extraOutputs) {
        try { stream.destroy(); } catch {}
      }
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${this.config.loggerTag}] _cleanup(): doneResolve/doneReject cleared`);
      }
    } finally {
      this.doneResolve = () => {};
      this.doneReject = () => {};
    }
  }

  private _parseProgress(line: string): Partial<FFmpegProgress> | null {
    const progress: Partial<FFmpegProgress> = {};
    const pairs = line.trim().split(/\s+/);
    for (const pair of pairs) {
      const [key, value] = pair.split("=", 2);
      if (!key || value == null) continue;
      switch (key) {
        case "frame":
          progress.frame = Number(value);
          break;
        case "total_size":
          progress.totalSize = Number(value);
          break;
        case "out_time_us":
          progress.outTimeUs = Number(value);
          break;
        case "out_time_ms":
          progress.outTimeMs = Number(value);
          break;
        case "dup_frames":
          progress.dupFrames = Number(value);
          break;
        case "drop_frames":
          progress.dropFrames = Number(value);
          break;
        case "packet":
          progress.packet = Number(value);
          break;
        case "chapter":
          progress.chapter = Number(value);
          break;
        case "fps":
          progress.fps = parseFloat(value.replace("x", ""));
          break;
        case "speed":
          progress.speed = parseFloat(value.replace("x", ""));
          break;
        case "bitrate":
          progress.bitrate = value;
          break;
        case "size":
          progress.size = value;
          break;
        case "out_time":
          progress.outTime = value;
          break;
        case "progress":
          progress.progress = value;
          break;
        case "time":
          progress.time = value;
          break;
      }
    }
    return Object.keys(progress).length > 0 ? progress : null;
  }

  public static create(params?: {
    args?: string[];
    inputStreams?: Array<{ stream: Readable; index: number }>;
    options?: ProcessorOptions;
    useAudioProcessor?: boolean;
    audioProcessorOptions?: AudioProcessingOptions;
  } & ProcessorOptions): Processor {
    if (!params || typeof params !== "object") return new Processor();

    let workerArgs: string[] | undefined;
    let workerInputStreams: Array<{ stream: Readable; index: number }> | undefined;
    let optionsObj: ProcessorOptions | undefined;

    if (Array.isArray(params.args)) workerArgs = [...params.args];
    if (Array.isArray(params.inputStreams)) workerInputStreams = params.inputStreams.map(({ stream, index }) => ({ stream, index }));
    const { args, inputStreams, options: extraOptions, ...restParams } = params;
    optionsObj = { ...(typeof extraOptions === "object" ? extraOptions : {}), ...restParams };

    const worker = new Processor(optionsObj);
    if (workerArgs) worker.setArgs(workerArgs);
    if (workerInputStreams) worker.inputStreams = workerInputStreams;

    if (typeof params.useAudioProcessor !== "undefined" || typeof params.audioProcessorOptions === "object") {
      worker.configureAudioProcessor(params.useAudioProcessor === false ? false : params.audioProcessorOptions);
    }
    return worker;
  }
}

export default Processor;

// Экспортируем константы для стороннего использования
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export const BASS_MIN = -20;
export const BASS_MAX = 20;
export const TREBLE_MIN = -20;
export const TREBLE_MAX = 20;

export interface FilterState {
  trebleL: number;
  trebleR: number;
  bass60L: number;
  bass60R: number;
  bass120L: number;
  bass120R: number;
  bassLowpassL: number;
  bassLowpassR: number;
}

export const SAMPLE_RATE = 48000;

export function userToGainLinear(userVal: number, maxDb = 12): number {
  const v = Math.max(-1, Math.min(1, userVal));
  const db = Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
  return Math.pow(10, db / 20);
}

export function userToGainDb(userVal: number, maxDb = 15): number {
  const v = Math.max(-1, Math.min(1, userVal));
  return Math.sign(v) * Math.pow(Math.abs(v), 0.5) * maxDb;
}

export function compressSample(value: number, threshold = 0.8, ratio = 4): number {
  const abs = Math.abs(value);
  if (abs <= threshold) return value;
  const excess = abs - threshold;
  const compressed = threshold + excess / ratio;
  return Math.sign(value) * compressed;
}

/** Clamp volume in valid range */
export function clampVolume(volume: number): number {
  return Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, volume));
}

/** Normalize bass [-20 .. 20] => -1..1 */
export function normalizeBass(bass: number): number {
  const range = BASS_MAX - BASS_MIN;
  if (range === 0) return 0;
  const normalized = ((bass - BASS_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

/** Normalize treble [-20 .. 20] => -1..1 */
export function normalizeTreble(treble: number): number {
  const range = TREBLE_MAX - TREBLE_MIN;
  if (range === 0) return 0;
  const normalized = ((treble - TREBLE_MIN) / range) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

/**
 * AudioProcessor - класс для Stereo PCM потоковой обработки и динамической регулировки эффектов.
 */
export class AudioProcessor extends Transform {
  public volume: number;
  public bass: number;
  public treble: number;
  public compressor: boolean;
  private isFading = false;
  public lastVolume: number;
  private isDestroyed = false;

  // Fade time tracking
  private fadeStartTime: number | null = null;
  private fadeDuration = 0;
  private fadeFrom = 0;
  private fadeTo = 0;
  private fadeAccumulatedMs = 0; // Accumulate "audio time" between calls, for more precise fade timing
  private fadePrevChunkTime: number | null = null;

  public filterState: FilterState = {
    trebleL: 0,
    trebleR: 0,
    bass60L: 0,
    bass60R: 0,
    bass120L: 0,
    bass120R: 0,
    bassLowpassL: 0,
    bassLowpassR: 0,
  };

  constructor(options: AudioProcessingOptions) {
    super();
    this.volume = clampVolume(options.volume);
    this.lastVolume = this.volume;
    this.bass = normalizeBass(options.bass);
    this.treble = normalizeTreble(options.treble);
    this.compressor = !!options.compressor;

    this.setupEventHandlers();
  }

  setVolume(volume: number): void {
    if (this.isDestroyed) return;
    this.lastVolume = this.volume;
    this.volume = clampVolume(volume);
  }

  startFade(targetVolume: number, duration: number): void {
    if (this.isDestroyed) return;
    this.isFading = true;
    this.fadeFrom = this.volume;
    this.fadeTo = clampVolume(targetVolume);
    this.fadeStartTime = Date.now();
    this.fadeDuration = duration;
    this.fadeAccumulatedMs = 0;
    this.fadePrevChunkTime = null;
    this.emit("fade-start", { from: this.fadeFrom, to: this.fadeTo });
  }

  setEqualizer(bass: number, treble: number, compressor: boolean): void {
    if (this.isDestroyed) return;
    this.bass = normalizeBass(bass);
    this.treble = normalizeTreble(treble);
    this.compressor = compressor;
  }

  setCompressor(enabled: boolean): void {
    if (this.isDestroyed) return;
    this.compressor = enabled;
  }

  processStereoSample(left: number, right: number, currentVolume?: number): [number, number] {
    const volume = typeof currentVolume === "number" ? currentVolume : this.volume;
    return this.processAudioSample(left, right, volume);
  }

  override _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: any) => void): void {
    if (this.isDestroyed || this.destroyed) {
      callback();
      return;
    }

    try {
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      const frameCount = samples.length / 2;
      const now = Date.now();

      // More accurate fade timing: use accumulated audio time, not Date.now + frame offset
      let chunkFadeStart: number;
      if (this.isFading && this.fadeStartTime !== null && this.fadeDuration > 0) {
        if (this.fadePrevChunkTime === null) {
          // first chunk of fade
          this.fadePrevChunkTime = now;
          chunkFadeStart = 0;
        } else {
          chunkFadeStart = this.fadeAccumulatedMs;
        }
      } else {
        chunkFadeStart = 0;
      }

      const msPerFrame = 1000 / SAMPLE_RATE;

      for (let frame = 0; frame < frameCount; frame++) {
        const idx = frame * 2;
        const left = samples[idx];
        const right = samples[idx + 1] ?? left;

        let currentVolume = this.volume;

        if (this.isFading && this.fadeStartTime !== null && this.fadeDuration > 0) {
          const frameTimeMs = chunkFadeStart + frame * msPerFrame;
          if (frameTimeMs >= this.fadeDuration) {
            this.volume = this.fadeTo;
            this.isFading = false;
            this.fadeStartTime = null;
            this.fadeAccumulatedMs = 0;
            this.fadePrevChunkTime = null;
            this.emit("fade-end", { to: this.fadeTo });
            currentVolume = this.volume;
          } else {
            const progress = Math.max(0, frameTimeMs / this.fadeDuration);
            currentVolume = this.fadeFrom + (this.fadeTo - this.fadeFrom) * progress;
          }
        }

        const [processedLeft, processedRight] = this.processAudioSample(
          left,
          right,
          currentVolume
        );

        samples[idx] = processedLeft;
        samples[idx + 1] = processedRight;
      }

      this.lastVolume = this.volume;

      // Track fade progress
      if (this.isFading && this.fadeStartTime !== null && this.fadeDuration > 0) {
        this.fadeAccumulatedMs += frameCount * msPerFrame;
        this.fadePrevChunkTime = now;
        if (this.fadeAccumulatedMs >= this.fadeDuration) {
          this.volume = this.fadeTo;
          this.isFading = false;
          this.fadeStartTime = null;
          this.fadeAccumulatedMs = 0;
          this.fadePrevChunkTime = null;
          this.emit("fade-end", { to: this.fadeTo });
        }
      }

      callback(null, chunk);
    } catch (error) {
      console.error("[AudioProcessor] Transform error:", error);
      this.safeDestroy();
      callback();
    }
  }

  private processAudioSample(left: number, right: number, currentVolume: number): [number, number] {
    let l = left / 32768;
    let r = right / 32768;

    l *= currentVolume;
    r *= currentVolume;

    if (Math.abs(this.bass) > 0.001) {
      [l, r] = this.applyBassFilter(l, r);
    }

    if (Math.abs(this.treble) > 0.001) {
      [l, r] = this.applyTrebleFilter(l, r);
    }

    if (this.compressor) {
      l = compressSample(l);
      r = compressSample(r);
    }

    l = Math.max(-1, Math.min(1, l));
    r = Math.max(-1, Math.min(1, r));

    return [Math.round(l * 32767), Math.round(r * 32767)];
  }

  private applyBassFilter(l: number, r: number): [number, number] {
    const bassGainDb = userToGainDb(this.bass, 18);

    const lowpassFreq =
      bassGainDb >= 0
        ? 4000 - (bassGainDb / 18) * 110
        : 4000 + (Math.abs(bassGainDb) / 18) * 1000;

    const lowpassQ =
      bassGainDb >= 0
        ? 0.7 + (bassGainDb / 18) * 1.8
        : 0.7 - (Math.abs(bassGainDb) / 18) * 0.4;

    const bassGain60 = userToGainLinear(this.bass * 0.7, 18);
    const alpha60 = (2 * Math.PI * 60) / SAMPLE_RATE;

    this.filterState.bass60L += alpha60 * (l - this.filterState.bass60L);
    this.filterState.bass60R += alpha60 * (r - this.filterState.bass60R);

    l += this.filterState.bass60L * (bassGain60 - 1);
    r += this.filterState.bass60R * (bassGain60 - 1);

    const eqGain120 = userToGainLinear(this.bass * 0.5, 18);
    const alpha120 = (2 * Math.PI * 120) / SAMPLE_RATE;

    this.filterState.bass120L += alpha120 * (l - this.filterState.bass120L);
    this.filterState.bass120R += alpha120 * (r - this.filterState.bass120R);

    l += this.filterState.bass120L * (eqGain120 - 1);
    r += this.filterState.bass120R * (eqGain120 - 1);

    const effectiveAlpha = (2 * Math.PI * lowpassFreq) / SAMPLE_RATE;
    const qInfluence = Math.min(lowpassQ * 0.5, 0.95);

    this.filterState.bassLowpassL =
      this.filterState.bassLowpassL * (1 - effectiveAlpha * qInfluence) +
      l * effectiveAlpha * qInfluence;
    this.filterState.bassLowpassR =
      this.filterState.bassLowpassR * (1 - effectiveAlpha * qInfluence) +
      r * effectiveAlpha * qInfluence;

    const blendFactor = 0.3 + (lowpassQ - 0.7) * 0.2;

    l = this.filterState.bassLowpassL + (l - this.filterState.bassLowpassL) * blendFactor;
    r = this.filterState.bassLowpassR + (r - this.filterState.bassLowpassR) * blendFactor;

    if (Math.abs(bassGainDb) > 6) {
      l = this.applyLimiter(l);
      r = this.applyLimiter(r);
    }

    return [l, r];
  }

  private applyTrebleFilter(l: number, r: number): [number, number] {
    const trebleGain = userToGainLinear(this.treble, 12);
    const alphaTreble = (2 * Math.PI * 4000) / SAMPLE_RATE;

    const lpStateL = this.filterState.trebleL + alphaTreble * (l - this.filterState.trebleL);
    const lpStateR = this.filterState.trebleR + alphaTreble * (r - this.filterState.trebleR);

    const highPassL = l - lpStateL;
    const highPassR = r - lpStateR;

    this.filterState.trebleL = lpStateL;
    this.filterState.trebleR = lpStateR;

    l += highPassL * (trebleGain - 1);
    r += highPassR * (trebleGain - 1);

    return [l, r];
  }

  private applyLimiter(value: number, threshold = 0.85, ratio = 8): number {
    const abs = Math.abs(value);
    if (abs <= threshold) return value;
    const excess = abs - threshold;
    const compressed = threshold + excess / ratio;
    return Math.sign(value) * compressed;
  }

  private setupEventHandlers(): void {
    this.on("error", (error) => {
      console.debug("[AudioProcessor] Error:", error?.message ?? error);
    });

    this.on("close", () => {
      console.debug("[AudioProcessor] Closed");
      this.isDestroyed = true;
    });

    this.on("finish", () => {
      console.debug("[AudioProcessor] Finished");
    });
  }

  private safeDestroy(): void {
    if (this.isDestroyed || this.destroyed) return;
    this.isDestroyed = true;
    try {
      this.removeAllListeners();
      super.destroy();
    } catch (error) {
      console.debug("[AudioProcessor] Destroy error:", (error as Error).message);
    }
  }

  override destroy(error?: Error): this {
    if (this.isDestroyed) return this;
    this.isDestroyed = true;
    this.removeAllListeners();
    super.destroy(error);
    return this;
  }
}
