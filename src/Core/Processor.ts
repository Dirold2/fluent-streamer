import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import type {
  Logger,
  FFmpegProgress,
  ProcessorDebugInfo,
} from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";
import { ThrottleStream } from "./ThrottleStream.js";
import { AudioProcessor } from './AudioProcessor.js';

interface PassThroughWithDrain extends PassThrough {
  _ffmpegDrainAttached?: boolean;
}

// Utils
function escapeParam(val: string | number | undefined): string | number | undefined {
  if (typeof val !== "string") return val;
  return val.replace(/[:=]/g, (m) => "\\" + m);
}

function getTimeString(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

export class Processor extends EventEmitter {
  private process: Subprocess | null = null;
  private passthrough: PassThroughWithDrain | null = null;
  private outputStream: PassThroughWithDrain | null = null;
  private blackholeStream: Writable | null = null;
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private extraOutputs: Array<{ stream: Writable; index: number }> = [];
  private stderrBuffer = "";
  private isTerminating = false;
  private hasFinished = false;
  private isClosed = false;
  private timeoutHandle?: NodeJS.Timeout;
  private progress: Partial<FFmpegProgress> = {};
  private currentBitrate: number = 128; // Default 128kbps
  private currentDuration: number = 180; // Default 3 minutes in seconds

  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private donePromise: Promise<void> | null = null;

  private readonly config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
    useAudioProcessor: boolean;
    audioProcessorOptions?: import("../Types/index.js").AudioProcessingOptions;
    disableThrottling?: boolean;
  };

  private args: string[] = [];
  private extraGlobalArgs: string[] = [];

  private _runEnded: boolean = false;
  private _runEmittedEnd: boolean = false;
  private _pendingProcessExitLog: (() => void) | null = null;

  private useAudioProcessor: boolean = false;
  private endSequenceFn: (() => void) | null = null;
  private throttledOutput: PassThrough | ThrottleStream | null = null;

  // Current audio processing settings for dynamic effects
  private currentVolume: number = 1;
  private currentBass: number = 0;
  private currentTreble: number = 0;
  private currentCompressor: boolean = false;

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
      logger: options.logger ?? console,
      debug: options.debug ?? false,
      verbose: options.verbose ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
      disableThrottling: options.disableThrottling ?? false,
      useAudioProcessor: typeof options.useAudioProcessor === "boolean" ? options.useAudioProcessor : false,
      audioProcessorOptions: options.audioProcessorOptions ?? { volume: 1, bass: 0, treble: 0, compressor: false, normalize: false },
    };

    this.extraGlobalArgs = [...this.config.extraGlobalArgs];
    this.useAudioProcessor = !!(options.useAudioProcessor);

    // Initialize current audio processing settings
    this.currentVolume = this.config.audioProcessorOptions?.volume ?? 1;
    this.currentBass = this.config.audioProcessorOptions?.bass ?? 0;
    this.currentTreble = this.config.audioProcessorOptions?.treble ?? 0;
    this.currentCompressor = this.config.audioProcessorOptions?.compressor ?? false;

    this._initPromise();
    this._handleAbortSignal();
  }

  private _initPromise() {
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

  public enableAudioProcessor(enable: boolean): this {
    this.useAudioProcessor = enable;
    return this;
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

  public run(): import("../Types/index.js").FFmpegRunResultExtended {
    if (this.process) throw new Error("FFmpeg process is already running");

    this._resetRunState();
    this._initPromise();

    const fullArgs = this.getFullArgs();
    if (this.config.onBeforeChildProcessSpawn) {
      try { this.config.onBeforeChildProcessSpawn(this.config.ffmpegPath, fullArgs); } catch {
        // Ignore errors from user callback
      }
    }

    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Starting ffmpeg process: ${this.config.ffmpegPath} ${fullArgs.join(" ")}`
      );
    }

    try {
      this.process = execa(this.config.ffmpegPath, fullArgs, {
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (ex) {
      this.config.logger.error?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`
      );
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();

    // Bind only index=0 to stdin, others to blackhole
    if (this.process.stdin && this.inputStreams.length) {
      const primary = this.inputStreams
        .slice()
        .sort((a, b) => a.index - b.index)[0];
      if (primary) {
        const throttled = primary.stream.pipe(new ThrottleStream(32_000));
        pipeline(throttled, this.process.stdin, (err) => {
          if (err) {
            // Ignore EPIPE if we're terminating/finished
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "EPIPE" && (this.hasFinished || this.isTerminating)) return;
            this.emit("error", err);
            this._finalize(err as Error);
          }
        });
      }
      // Drain other inputs (if any), but don't feed to ffmpeg stdin
      for (const s of this.inputStreams) {
        if (s !== primary) {
          pipeline(s.stream, this._getBlackholeStream(), () => {});
        }
      }
    }

    const finalPassthrough = new PassThrough({ highWaterMark: 16384 }) as PassThroughWithDrain;

    // PCM s16le 48kHz stereo: 48000 * 2 * 2 = 192000 bytes/second
    const BYTES_PER_SECOND = 48000 * 2 * 2;

    // Always build an AudioProcessor with current settings
    const audioProcessor = new AudioProcessor({
      volume: this.currentVolume,
      bass: this.currentBass,
      treble: this.currentTreble,
      compressor: this.currentCompressor,
      normalize: false,
      sampleRate: 48000,
      channels: 2,
    });

    if (!this.useAudioProcessor) {
      audioProcessor.setVolume(1);
      audioProcessor.setEqualizer(0, 0, false);
      // Без фейдов/обработки — прямая передача данных (bypass активируется автоматически)
    }

    // Create throttled output for real-time playback
    this.throttledOutput = this.config.disableThrottling
      ? new PassThrough()
      : new ThrottleStream(BYTES_PER_SECOND);

    // Use pipeline for smooth audio flow: process.stdout -> audioProcessor -> throttledOutput -> finalPassthrough
    if (this.process.stdout) {
      let stdoutChunks = 0;
      let audioProcessorChunks = 0;
      let throttledChunks = 0;
      let outputChunks = 0;

      // Add logging to process.stdout
      this.process.stdout.on("data", (chunk) => {
        stdoutChunks++;
        if (this.config.debug || this.config.verbose) {
          if (stdoutChunks % 500 === 0) {
            this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] FFmpeg stdout chunk ${stdoutChunks}: ${chunk.length} bytes`);
          }
        }
      });

      this.process.stdout.on("end", () => {
        this._runEnded = true;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] FFmpeg stdout ended: total chunks=${stdoutChunks}`);
        }
        // Don't call endSequence here, let pipeline finish naturally
      });

      this.process.stdout.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      // Add logging to audioProcessor output
      audioProcessor.on("data", (chunk) => {
        audioProcessorChunks++;
        if (this.config.debug || this.config.verbose) {
          if (audioProcessorChunks % 500 === 0) {
            this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] AudioProcessor chunk ${audioProcessorChunks}: ${chunk.length} bytes`);
          }
        }
      });

      audioProcessor.on("end", () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] AudioProcessor ended: total chunks=${audioProcessorChunks}`);
        }
        // AudioProcessor ended, but we don't call endSequence here anymore
      });

      audioProcessor.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      // Add logging to throttledOutput
      this.throttledOutput.on("data", (chunk) => {
        throttledChunks++;
        if (this.config.debug || this.config.verbose) {
          if (throttledChunks % 500 === 0) {
            this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Throttled chunk ${throttledChunks}: ${chunk.length} bytes`);
          }
        }
      });

      this.throttledOutput.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      // Add logging to final output
      finalPassthrough.on("data", (chunk) => {
        outputChunks++;
        if (this.config.debug || this.config.verbose) {
          if (outputChunks % 500 === 0) {
            this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Output chunk ${outputChunks}: ${chunk.length} bytes`);
          }
        }
      });

      finalPassthrough.on("end", () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Output ended: total chunks=${outputChunks}`);
        }
      });

      // Use pipeline for smooth flow
      pipeline(this.process.stdout, audioProcessor, this.throttledOutput, finalPassthrough, (err) => {
        if (err && !this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });
    } else {
      // ffmpeg не отдал stdout — пустой поток
      finalPassthrough.end();
    }

    // We'll monitor/drain the final output to avoid back-pressure if consumer is late
    this.passthrough = finalPassthrough;
    this.outputStream = finalPassthrough;
    this._ensureFinalOutputDrained(finalPassthrough);

    this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
    this.process.stderr?.on("data", (chunk) => {
      try {
        this.config.stderrLogHandler?.(chunk.toString("utf8"));
      } catch {
        // Ignore errors from user stderr handler
      }
    });

    this.process.once("exit", (code, signal) => {
      this._pendingProcessExitLog = () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`
          );
        }
      };
      this._onProcessExit(code, signal);
    });

    this.process.once("error", (err: Error) => {
      this.config.logger.error?.(`[${getTimeString()}] [${this.config.loggerTag}] Process error: ${err.message}`);
      this.emit("error", err);
      this._finalize(err);
    });

    // graceful end sequence
    this.endSequenceFn = this._createEndSequence(audioProcessor, finalPassthrough);

    this.donePromise!.catch((err) => {
      this.emit("error", err);
      if (!this._runEmittedEnd && finalPassthrough && !finalPassthrough.destroyed) {
        finalPassthrough.destroy(err);
      }
    });

    return {
      output: finalPassthrough,
      passthrough: finalPassthrough,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
      audioProcessor,
      setVolume: (v: number) => {
        this.currentVolume = v;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] setVolume(${v}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        if (audioProcessor && !audioProcessor.destroyed && !audioProcessor.writableEnded) {
          audioProcessor.setVolume(v);
        }
      },
      setBass: (b: number) => {
        this.currentBass = b;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] setBass(${b}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        if (audioProcessor && !audioProcessor.destroyed && !audioProcessor.writableEnded) {
          audioProcessor.setEqualizer(b, audioProcessor.treble, audioProcessor.compressor);
        }
      },
      setTreble: (t: number) => {
        this.currentTreble = t;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] setTreble(${t}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        if (audioProcessor && !audioProcessor.destroyed && !audioProcessor.writableEnded) {
          audioProcessor.setEqualizer(audioProcessor.bass, t, audioProcessor.compressor);
        }
      },
      setCompressor: (c: boolean) => {
        this.currentCompressor = c;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] setCompressor(${c}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        if (audioProcessor && !audioProcessor.destroyed && !audioProcessor.writableEnded) {
          audioProcessor.setCompressor(c);
        }
      },
      setEqualizer: (b: number, t: number, c: boolean) => {
        this.currentBass = b;
        this.currentTreble = t;
        this.currentCompressor = c;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] setEqualizer(${b}, ${t}, ${c}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        if (audioProcessor && !audioProcessor.destroyed && !audioProcessor.writableEnded) {
          audioProcessor.setEqualizer(b, t, c);
        }
      },
      startFade: (targetVolume: number, durationMs: number) => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] startFade(${targetVolume}, ${durationMs}) called, audioProcessor=${!!audioProcessor}, destroyed=${audioProcessor?.destroyed}, writableEnded=${audioProcessor?.writableEnded}`);
        }
        return audioProcessor?.startFade(targetVolume, durationMs);
      },
    };
  }

  private _createEndSequence(_audioProcessor: AudioProcessor, finalPassthrough: PassThrough) {
    return () => {
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] _createEndSequence called: _runEmittedEnd=${this._runEmittedEnd}, hasFinished=${this.hasFinished}, isClosed=${this.isClosed}`);
      }
      if (this._runEmittedEnd || this.hasFinished || this.isClosed) return;
      this._runEmittedEnd = true;

      const finalize = () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Finalizing end sequence: finalPassthrough destroyed=${finalPassthrough.destroyed}, writableEnded=${finalPassthrough.writableEnded}`);
        }
        if (!finalPassthrough.destroyed && !finalPassthrough.writableEnded) {
          finalPassthrough.end();
        }
        this.emit("end");
        if (this._pendingProcessExitLog) {
          this._pendingProcessExitLog();
          this._pendingProcessExitLog = null;
        }
        this._finalize();
      };

      // Finalize immediately without adding silence to prevent consumer from closing on silence
      setImmediate(finalize);
    };
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this._runEmittedEnd = true;

    if (this.passthrough && !this.passthrough.destroyed) {
      this.passthrough.end();
      this.passthrough.destroy();
    }
    this.outputStream?.destroy();

    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Closed processor stream via .close()`
      );
    }
    await this.kill();
    await this.donePromise;
    this._finalize();
  }

  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Killing process with signal ${signal}`
        );
      }
      try {
        this.process.kill(signal);
      } catch {
        // Ignore kill errors
      }
    }
    if (this.donePromise) {
      try {
        await this.donePromise;
      } catch {
        // ignore
      }
    }
  }

  public destroy(): void {
    this.config.logger?.warn?.(
      `[${getTimeString()}] [${this.config.loggerTag}] Processor force destroy() called at ${new Date().toISOString()}`
    );
    void this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"));
    this.removeAllListeners();
  }

  public static buildAcrossfadeFilter(
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

  public debugDump(): ProcessorDebugInfo {
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

  private _resetRunState() {
    if (this.outputStream && (this.outputStream as PassThroughWithDrain)._ffmpegDrainAttached) {
      delete (this.outputStream as PassThroughWithDrain)._ffmpegDrainAttached;
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
    this.endSequenceFn = null;
    this.throttledOutput = null;

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

  private _ensureFinalOutputDrained(output: PassThroughWithDrain) {
    if (!output || output._ffmpegDrainAttached) return;

    let consumerAttached = false;

    const markRead = () => {
      if (!output || output.destroyed || output.writableEnded) return;
      consumerAttached = true;
      output._ffmpegDrainAttached = true;
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Consumer attached to output stream`);
      }
    };

    const events = ["data", "readable", "end", "close"];
    const isBeingRead = () =>
      output && !output.destroyed && !output.writableEnded && output.listeners("data").length > 0;

    const maybeDrain = () => {
      if (!consumerAttached && output && !output._ffmpegDrainAttached && !isBeingRead()) {
        output._ffmpegDrainAttached = true;
        output.pipe(this._getBlackholeStream(), { end: false });
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Final output drained to blackhole to prevent backpressure`
          );
        }
      }
    };

    events.forEach((ev) => output.once(ev, markRead));
    output.once("newListener", (event: string) => {
      if (events.includes(event)) {
        markRead();
        clearTimeout(timer);
      }
    });

    const timer = setTimeout(maybeDrain, 100);
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
      if (this.config.debug || this.config.verbose) {
        this.config.logger.warn?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`
        );
      }
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
    const bytesPerSecond = sampleRate * channels * 2; // 2 bytes per sample
    const silenceBytes = Math.floor((durationMs / 1000) * bytesPerSecond);
    // Adaptive chunk size based on bitrate: 128kbps -> 256 bytes, 320kbps -> 512 bytes
    const adaptiveChunkSize = Math.min(512, Math.max(128, (this.currentBitrate / 128) * 256));
    const chunkSize = Math.min(adaptiveChunkSize, silenceBytes); // Generate chunks based on bitrate for smoother streaming
    let silenceSent = 0;

    return new Readable({
      highWaterMark: 4096,
      read() {
        if (silenceSent >= silenceBytes) {
          this.push(null); // End of stream
          return;
        }

        const remaining = silenceBytes - silenceSent;
        const sendSize = Math.min(chunkSize, remaining);
        const chunk = Buffer.alloc(sendSize, 0); // Silence = all zeros
        this.push(chunk);
        silenceSent += sendSize;
      },
    });
  }

  public createSilenceBuffer(durationMs = 100, sampleRate = 48000, channels = 2): Buffer {
    const bytesPerSample = 2;
    const totalBytes = Math.floor(
      (durationMs / 1000) * sampleRate * channels * bytesPerSample
    );
    return Buffer.alloc(totalBytes, 0);
  }

  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");

    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
        this.stderrBuffer = this.stderrBuffer.slice(
          this.stderrBuffer.length - this.config.maxStderrBuffer
        );
      }
    }

    // Parse duration from stderr
    const durationMatch = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
    if (durationMatch) {
      const hours = parseInt(durationMatch[1], 10);
      const minutes = parseInt(durationMatch[2], 10);
      const seconds = parseInt(durationMatch[3], 10);
      const milliseconds = parseInt(durationMatch[4].substring(0, 3), 10); // Take first 3 digits for ms
      const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      this.currentDuration = Math.max(1, Math.min(3600, totalSeconds)); // Clamp to 1-3600 seconds
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Detected duration: ${this.currentDuration} seconds`);
      }
    }

    // Parse bitrate from stderr
    const bitrateMatch = text.match(/bitrate=\s*(\d+(?:\.\d+)?)\s*(k(?:b\/s)?|M(?:b\/s)?)/i);
    if (bitrateMatch) {
      const value = parseFloat(bitrateMatch[1]);
      const unit = bitrateMatch[2].toLowerCase();
      let bitrateKbps = value;
      if (unit.startsWith('m')) {
        bitrateKbps = value * 1000; // Convert Mbps to kbps
      }
      this.currentBitrate = Math.max(32, Math.min(320, bitrateKbps)); // Clamp to reasonable range
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Detected bitrate: ${this.currentBitrate} kbps`);
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
    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] _onProcessExit called: code=${code}, signal=${signal}, hasFinished=${this.hasFinished}, _runEmittedEnd=${this._runEmittedEnd}`);
    }
    if (this.hasFinished) return;
    if (code === 0 || (signal !== null && this.isTerminating)) {
      if (this.isTerminating) {
        this.emit("terminated", signal ?? "SIGTERM");
      }
      this.config.logger.info?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Process exited normally with code ${code}, signal ${signal} at ${new Date().toISOString()}`
      );

      if (!this._runEmittedEnd) {
        this._runEnded = true;
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Scheduling end sequence, endSequenceFn=${!!this.endSequenceFn}`);
        }
        setImmediate(() => {
          if (this.endSequenceFn && !this._runEmittedEnd) {
            if (this.config.debug || this.config.verbose) {
              this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] Calling end sequence`);
            }
            this.endSequenceFn();
          }
        });
      }
    } else {
      const error = this._getProcessExitError(code, signal);
      const tail = this.stderrBuffer.trim().slice(-4000);
      if (tail && (this.config.debug || this.config.verbose)) {
        this.config.logger.error?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`
        );
      }
      this.emit("error", error);
      this._finalize(error);
    }
  }

  private _getProcessExitError(
    code: number | null,
    signal: NodeJS.Signals | null
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
    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(`[${getTimeString()}] [${this.config.loggerTag}] _finalize called: hasFinished=${this.hasFinished}, error=${!!error}`);
    }
    if (this.hasFinished) return;
    this.hasFinished = true;
    try {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      this._cleanup();

      // Only emit "end" and end() the stream if we haven't been destroyed by consumer
      if (this.outputStream && !this.outputStream.destroyed && !this.outputStream.writableEnded) {
        this.outputStream.end();
        this.emit("end");
      }

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
    try { this.process?.stdout?.destroy(); } catch {
      // Ignore cleanup errors
    }
    try { this.process?.stderr?.destroy(); } catch {
      // Ignore cleanup errors
    }
    try { this.outputStream?.destroy(); } catch {
      // Ignore cleanup errors
    }
    try { this.passthrough?.destroy(); } catch {
      // Ignore cleanup errors
    }
    try { this.blackholeStream?.destroy(); } catch {
      // Ignore cleanup errors
    }
    try { this.throttledOutput?.destroy(); } catch {
      // Ignore cleanup errors
    }
    for (const { stream } of this.extraOutputs) {
      try { stream.destroy(); } catch {
        // Ignore cleanup errors
      }
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
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

  static create(params?: {
    args?: string[];
    inputStreams?: Array<{ stream: Readable; index: number }>;
    options?: ProcessorOptions;
  } & Partial<ProcessorOptions>): Processor {
    if (!params || typeof params !== "object") return new Processor();

    const { options: extraOptions, args: workerArgs, inputStreams: workerInputStreams, ...restParams } = params;
    const optionsObj = { ...(typeof extraOptions === "object" ? extraOptions : {}), ...restParams };

    const worker = new Processor(optionsObj);
    if (workerArgs) worker.setArgs(workerArgs);
    if (workerInputStreams) worker.inputStreams = workerInputStreams.map(({ stream, index }) => ({ stream, index }));
    return worker;
  }
}

export default Processor;
