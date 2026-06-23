import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import { resolveObjectURL } from "buffer";
import type { Logger, FFmpegProgress, ProcessorDebugInfo, InputSource } from "../Types/index.js";
import type { ProcessorOptions } from "../Types/index.js";
import { ThrottleStream } from "./ThrottleStream.js";
import { AudioProcessor } from "./AudioProcessor.js";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface PassThroughWithDrain extends PassThrough {
  _ffmpegDrainAttached?: boolean;
}

// ============================================================================
// UTILS
// ============================================================================
function getTimeString(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ============================================================================
// AUDIO EFFECT CONTROLLER
// ============================================================================

class AudioEffectController {
  private audioProcessor: AudioProcessor;
  private logger: Logger;
  private loggerTag: string;
  private verbose: boolean;

  private _volume: number;
  private _bass: number;
  private _treble: number;
  private _compressor: boolean;

  constructor(
    audioProcessor: AudioProcessor,
    config: { logger: Logger; loggerTag: string; verbose?: boolean },
    initialState: {
      volume: number;
      bass: number;
      treble: number;
      compressor: boolean;
    },
  ) {
    this.audioProcessor = audioProcessor;
    this.logger = config.logger;
    this.loggerTag = config.loggerTag;
    this.verbose = config.verbose ?? false;
    this._volume = initialState.volume;
    this._bass = initialState.bass;
    this._treble = initialState.treble;
    this._compressor = initialState.compressor;
  }

  setVolume(v: number): void {
    const oldValue = this._volume;
    this._volume = v;
    if (this.canUpdate()) {
      this.audioProcessor.setVolume(v);
    }
    this.logChange("Volume", oldValue, v);
  }

  setBass(b: number): void {
    const oldValue = this._bass;
    this._bass = b;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(b, this._treble, this._compressor);
    }
    this.logChange("Bass", oldValue, b);
  }

  setTreble(t: number): void {
    const oldValue = this._treble;
    this._treble = t;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(this._bass, t, this._compressor);
    }
    this.logChange("Treble", oldValue, t);
  }

  setCompressor(c: boolean): void {
    const oldValue = this._compressor;
    this._compressor = c;
    if (this.canUpdate()) {
      this.audioProcessor.setCompressor(c);
    }
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] Compressor changed: ${String(oldValue)} → ${String(c)}`,
      );
    }
  }

  setEqualizer(b: number, t: number, c: boolean): void {
    this._bass = b;
    this._treble = t;
    this._compressor = c;
    if (this.canUpdate()) {
      this.audioProcessor.setEqualizer(b, t, c);
    }
  }

  startFade(targetVolume: number, durationMs: number): void {
    this.audioProcessor?.startFade(targetVolume, durationMs);
  }

  private canUpdate(): boolean {
    return (
      this.audioProcessor != null &&
      !this.audioProcessor.destroyed &&
      !this.audioProcessor.writableEnded
    );
  }

  private logChange(label: string, oldValue: number, newValue: number): void {
    if (this.verbose) {
      this.logger.info?.(
        `[${getTimeString()}] [${this.loggerTag}] ${label} changed: ${oldValue} → ${newValue}`,
      );
    }
  }
}

// ============================================================================
// PROCESSOR CLASS
// ============================================================================
/**
 * FFmpeg Stream Processor with Audio Effects
 *
 * Универсальный процессор потоков FFmpeg с поддержкой:
 * - Real-time аудио-обработки (громкость, EQ, компрессия)
 * - Управления жизненным циклом процесса
 * - Progress tracking и error handling
 * - Graceful shutdown с хвостовой тишиной
 * - URL входов (HTTP/HTTPS/RTMP/RTMPS/RTSP)
 */
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
  private currentBitrate: number = 128;
  private currentDuration: number = 180;
  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private donePromise: Promise<void> | null = null;
  private args: string[] = [];
  private extraGlobalArgs: string[] = [];
  private _runEnded: boolean = false;
  private _runEmittedEnd: boolean = false;
  private _pendingProcessExitLog: (() => void) | null = null;
  private useAudioProcessor: boolean = false;
  private endSequenceFn: (() => void) | null = null;
  private throttledOutput: PassThrough | ThrottleStream | null = null;
  private currentVolume: number = 1;
  private currentBass: number = 0;
  private currentTreble: number = 0;
  private currentCompressor: boolean = false;
  private _bitrateDetected: boolean = false;
  private _startTime: number = 0;
  private _totalChunks: number = 0;
  private _skipInProgress: boolean = false;
  private _lastSkipTime: number = 0;
  private readonly SKIP_DEBOUNCE_MS: number = 500;

  private readonly config: Required<
    Omit<
      ProcessorOptions,
      | "abortSignal"
      | "logger"
      | "verbose"
      | "useAudioProcessor"
      | "audioProcessorOptions"
      | "disableThrottling"
    >
  > & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
    useAudioProcessor: boolean;
    audioProcessorOptions?: import("../Types/index.js").AudioProcessingOptions;
    disableThrottling?: boolean;

    onBeforeChildProcessSpawn?: (ffmpegPath: string, args: string[]) => void;
    stderrLogHandler?: (chunk: string) => void;
    inputStreams: Array<{ stream: Readable; index: number }>;
  };

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
      executionId: options.executionId ?? Math.random().toString(36).slice(2) + Date.now(),
      wallTimeLimit: options.wallTimeLimit ?? 0,
      timeout: options.timeout ?? 0,
      maxStderrBuffer: options.maxStderrBuffer ?? 1024 * 1024,
      enableProgressTracking: options.enableProgressTracking ?? false,
      logger: options.logger ?? console,
      debug: options.debug ?? false,
      verbose: options.verbose ?? false,
      stdoutlog: options.stdoutlog ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
      userAgent: options.userAgent ?? "Mozilla/5.0 (compatible; FFmpegProcessor/1.0)",
      disableThrottling: options.disableThrottling ?? true,
      ffmpegLogLevel: options.ffmpegLogLevel ?? "info",
      tailSilenceMs: options.tailSilenceMs ?? 0,
      useAudioProcessor:
        typeof options.useAudioProcessor === "boolean" ? options.useAudioProcessor : false,
      inputSources: [],
      audioProcessorOptions: options.audioProcessorOptions ?? {
        volume: 1,
        bass: 0,
        treble: 0,
        compressor: false,
        normalize: false,
      },
    };

    this.extraGlobalArgs = [...this.config.extraGlobalArgs];
    this.useAudioProcessor = !!options.useAudioProcessor;

    this.currentVolume = this.config.audioProcessorOptions?.volume ?? 1;
    this.currentBass = this.config.audioProcessorOptions?.bass ?? 0;
    this.currentTreble = this.config.audioProcessorOptions?.treble ?? 0;
    this.currentCompressor = this.config.audioProcessorOptions?.compressor ?? false;

    this._initPromise();
    this._handleAbortSignal();
  }

  private _initPromise() {
    this.donePromise = new Promise((resolve, reject) => {
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

  public setInputSources(sources: InputSource[]): this {
    this.config.inputSources = Array.isArray(sources) ? [...sources] : [];
    return this;
  }

  public getFullArgs(): string[] {
    const args: string[] = [];

    if (this.config.ffmpegLogLevel) {
      args.push("-loglevel", this.config.ffmpegLogLevel);
    }

    // Only add user_agent if there are HTTP URLs in the inputs
    const hasHttpInputs = this.config.inputSources.some(
      (source) => source.type === "url" && source.url.startsWith("http"),
    );

    if (this.config.userAgent && hasHttpInputs) {
      args.push("-user_agent", this.config.userAgent);
    }

    args.push(...this.extraGlobalArgs);

    const sortedUrlSources = [...this.config.inputSources]
      .filter(
        (
          s,
        ): s is {
          type: "url";
          url: string;
          index: number;
          headers?: Record<string, string>;
        } => s.type === "url",
      )
      .sort((a, b) => a.index - b.index);

    for (const source of sortedUrlSources) {
      const globalHeaders = typeof this.config.headers === "object" ? this.config.headers : {};
      const finalHeaders = { ...globalHeaders, ...source.headers };

      if (Object.keys(finalHeaders).length > 0) {
        const headerStr = Object.entries(finalHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n");
        args.push("-headers", headerStr);
      }

      args.push(
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-timeout",
        "10000000",
      );
      args.push("-i", source.url);
    }

    args.push(...this.args);
    return args;
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

  /**
   * Create a Readable stream from ArrayBuffer data
   * Создать Readable поток из данных ArrayBuffer
   */
  private _createStreamFromArrayBuffer(arrayBuffer: ArrayBuffer): Readable {
    const buffer = Buffer.from(arrayBuffer);
    let offset = 0;
    const chunkSize = 64 * 1024; // 64KB chunks

    return new Readable({
      read() {
        if (offset >= buffer.length) {
          this.push(null);
          return;
        }

        const chunk = buffer.slice(offset, offset + chunkSize);
        this.push(chunk);
        offset += chunk.length;
      },
    });
  }

  /**
   * Check if ArrayBuffer contains valid audio data by examining file signatures
   * Проверить, содержит ли ArrayBuffer валидные аудио данные путем проверки сигнатур файлов
   */
  private _validateAudioData(arrayBuffer: ArrayBuffer): boolean {
    if (arrayBuffer.byteLength < 12) {
      return false; // Too small to be audio
    }

    const view = new Uint8Array(arrayBuffer);

    // Check for MP3 signature (ID3v2 or MPEG frame)
    if (view[0]! === 0x49 && view[1]! === 0x44 && view[2]! === 0x33) {
      // ID3v2
      return true;
    }
    if (view[0]! === 0xff && (view[1]! & 0xe0) === 0xe0) {
      // MPEG frame sync
      return true;
    }

    // Check for WAV signature
    if (view[0]! === 0x52 && view[1]! === 0x49 && view[2]! === 0x46 && view[3]! === 0x46) {
      // RIFF
      return view[8]! === 0x57 && view[9]! === 0x41 && view[10]! === 0x56 && view[11]! === 0x45; // WAVE
    }

    // Check for OGG signature
    if (view[0]! === 0x4f && view[1]! === 0x67 && view[2]! === 0x67 && view[3]! === 0x53) {
      // OggS
      return true;
    }

    // Check for FLAC signature
    if (view[0]! === 0x66 && view[1]! === 0x4c && view[2]! === 0x61 && view[3]! === 0x43) {
      // fLaC
      return true;
    }

    // Check for AAC (ADTS)
    if (view[0]! === 0xff && (view[1]! & 0xf0) === 0xf0) {
      // ADTS sync
      return true;
    }

    // If no known signature found, but data exists, we'll assume it's audio
    // FFmpeg will give us a proper error if it's not playable
    return arrayBuffer.byteLength > 100; // Minimum reasonable audio size
  }

  /**
   * Resolve blob URL to Readable stream with audio validation
   * Разрешить blob URL в Readable поток с валидацией аудио данных
   */
  private async _resolveBlobToStream(blobUrl: string): Promise<Readable> {
    try {
      const blob = resolveObjectURL(blobUrl);
      if (!blob) {
        throw new Error(`Blob not found for URL: ${blobUrl}`);
      }

      const arrayBuffer = await blob.arrayBuffer();

      // Validate that we have audio data
      if (!this._validateAudioData(arrayBuffer)) {
        throw new Error(
          `Blob URL ${blobUrl} does not contain valid audio data (size: ${arrayBuffer.byteLength} bytes)`,
        );
      }

      if (this.config.verbose) {
        this.config.logger.info?.(
          `[${getTimeString()}] [${this.config.loggerTag}] ✅ Validated audio data from blob: ${arrayBuffer.byteLength} bytes`,
        );
      }

      return this._createStreamFromArrayBuffer(arrayBuffer);
    } catch (error) {
      throw new Error(`Failed to resolve blob URL ${blobUrl}: ${error}`);
    }
  }

  public async run(): Promise<import("../Types/index.js").FFmpegRunResultExtended> {
    if (this.process) throw new Error("FFmpeg process is already running");
    if (this._skipInProgress) throw new Error("Skip operation in progress");

    this._resetRunState();
    this._initPromise();
    this._startTime = Date.now();
    this._totalChunks = 0;

    // Handle blob inputs by resolving them to streams
    // Обработка blob входов путем разрешения их в потоки
    const blobPromises: Promise<void>[] = [];
    for (const source of this.config.inputSources) {
      if (source.type === "blob") {
        const promise = this._resolveBlobToStream(source.blobUrl).then((stream) => {
          this.inputStreams.push({ stream, index: source.index });
        });
        blobPromises.push(promise);
      }
    }

    // Wait for all blob resolutions
    // Ждем разрешения всех blob
    await Promise.all(blobPromises);

    const fullArgs = this.getFullArgs();

    if (this.config.onBeforeChildProcessSpawn) {
      try {
        this.config.onBeforeChildProcessSpawn(this.config.ffmpegPath, fullArgs);
      } catch {
        // Ignore errors from user callback
      }
    }

    if (this.config.verbose) {
      this.config.logger.info?.(
        `[${getTimeString()}] [${this.config.loggerTag}] FFmpeg command: ${this.config.ffmpegPath} ${fullArgs.join(" ")}`,
      );
      this.config.logger.info?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Audio config: volume=${this.currentVolume}, bass=${this.currentBass}dB, treble=${this.currentTreble}dB, compressor=${this.currentCompressor}`,
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
        `[${getTimeString()}] [${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`,
      );
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();

    if (this.process.stdin && this.inputStreams.length) {
      if (this.inputStreams.length > 1) {
        const error = new Error(
          "Multiple stream inputs are not supported. " +
            "Provide additional inputs as file paths or URLs.",
        );
        this.emit("error", error);
        this._finalize(error);
        throw error;
      }

      const primary = this.inputStreams[0]!;
      const throttled = primary.stream.pipe(new ThrottleStream(32_000));
      pipeline(throttled, this.process.stdin, (err) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "EPIPE" && (this.hasFinished || this.isTerminating)) return;
          this.emit("error", err);
          this._finalize(err as Error);
        }
      });
    }

    const finalPassthrough = new PassThrough({
      highWaterMark: 16384,
    }) as PassThroughWithDrain;
    const sampleRate = this.config.audioProcessorOptions?.sampleRate ?? 48000;
    const channels = this.config.audioProcessorOptions?.channels ?? 2;
    const BYTES_PER_SECOND = sampleRate * channels * 2; // 16-bit PCM

    const audioProcessor = new AudioProcessor({
      volume: this.currentVolume,
      bass: this.currentBass,
      treble: this.currentTreble,
      compressor: this.currentCompressor,
      normalize: false,
      sampleRate,
      channels,
    });

    if (!this.useAudioProcessor) {
      audioProcessor.setVolume(1);
      audioProcessor.setEqualizer(0, 0, false);
    }

    this.throttledOutput = this.config.disableThrottling
      ? new PassThrough()
      : new ThrottleStream(BYTES_PER_SECOND);

    if (this.process.stdout) {
      this.process.stdout.on("data", () => {
        this._totalChunks++;
      });

      this.process.stdout.on("end", () => {
        this._runEnded = true;
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] FFmpeg stdout ended: total chunks=${this._totalChunks}`,
          );
        }
      });

      this.process.stdout.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      audioProcessor.on("end", () => {
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] AudioProcessor ended`,
          );
        }
      });

      audioProcessor.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      this.throttledOutput.on("error", (err) => {
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      finalPassthrough.on("end", () => {
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Output stream ended`,
          );
        }
      });

      finalPassthrough.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        // Игнорируем premature close при нормальном завершении
        if (code === "ERR_STREAM_PREMATURE_CLOSE" && this.hasFinished) {
          if (this.config.verbose) {
            this.config.logger.debug?.(
              `[${getTimeString()}] [${this.config.loggerTag}] Ignoring premature close on finished stream`,
            );
          }
          return;
        }
        if (!this.hasFinished) {
          this.emit("error", err);
          this._finalize(err);
        }
      });

      pipeline(
        this.process.stdout,
        audioProcessor,
        this.throttledOutput,
        finalPassthrough,
        (err) => {
          if (err && !this.hasFinished) {
            this.emit("error", err);
            this._finalize(err);
          }
        },
      );
    } else {
      finalPassthrough.end();
    }

    this.passthrough = finalPassthrough;
    this.outputStream = finalPassthrough;
    this._ensureFinalOutputDrained(finalPassthrough);

    this.process.stderr?.on("data", (chunk: Buffer) => {
      this._handleStderr(chunk);
      try {
        this.config.stderrLogHandler?.(chunk.toString("utf8"));
      } catch {
        // Ignore errors from user stderr handler
      }
    });

    this.process.once("exit", (code, signal) => {
      this._pendingProcessExitLog = () => {
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`,
          );
        }
      };
      this._onProcessExit(code, signal);
    });

    this.process.once("error", (err: Error) => {
      this.config.logger.error?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Process error: ${err.message}`,
      );
      this.emit("error", err);
      this._finalize(err);
    });

    this.endSequenceFn = this._createEndSequence(audioProcessor, finalPassthrough);

    this.donePromise!.catch((err) => {
      this.emit("error", err);
      if (!this._runEmittedEnd && finalPassthrough && !finalPassthrough.destroyed) {
        finalPassthrough.destroy(err);
      }
    });

    const controller = new AudioEffectController(audioProcessor, this.config, {
      volume: this.currentVolume,
      bass: this.currentBass,
      treble: this.currentTreble,
      compressor: this.currentCompressor,
    });

    return {
      output: finalPassthrough,
      passthrough: finalPassthrough,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
      audioProcessor,
      setVolume: (v) => controller.setVolume(v),
      setBass: (b) => controller.setBass(b),
      setTreble: (t) => controller.setTreble(t),
      setCompressor: (c) => controller.setCompressor(c),
      setEqualizer: (b, t, c) => controller.setEqualizer(b, t, c),
      startFade: (tv, dur) => controller.startFade(tv, dur),
    };
  }

  private _createEndSequence(_audioProcessor: AudioProcessor, finalPassthrough: PassThrough) {
    return () => {
      if (this._runEmittedEnd || this.hasFinished || this.isClosed) return;
      this._runEmittedEnd = true;

      if (this.throttledOutput && !this.throttledOutput.destroyed) {
        this.throttledOutput.once("end", () => {
          // Даём AudioPlayer время обработать оставшиеся данные
          setTimeout(() => {
            if (!finalPassthrough.destroyed && !finalPassthrough.writableEnded) {
              finalPassthrough.end();
            }
            this.emit("end");
            if (this._pendingProcessExitLog) {
              this._pendingProcessExitLog();
              this._pendingProcessExitLog = null;
            }
            this._finalize();
          }, 100); // 100ms задержка
        });
      } else {
        setTimeout(() => {
          if (!finalPassthrough.destroyed && !finalPassthrough.writableEnded) {
            finalPassthrough.end();
          }
          this.emit("end");
          if (this._pendingProcessExitLog) {
            this._pendingProcessExitLog();
            this._pendingProcessExitLog = null;
          }
          this._finalize();
        }, 100);
      }
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

    if (this.config.verbose) {
      this.config.logger.debug?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Closed processor stream via .close()`,
      );
    }

    await this.kill();
    await this.donePromise;
    this._finalize();
  }

  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      this._skipInProgress = true;

      if (this.config.verbose) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Killing process with signal ${signal}`,
        );
      }

      try {
        // Сначала останавливаем стримы
        if (this.throttledOutput && !this.throttledOutput.destroyed) {
          this.throttledOutput.destroy();
        }

        if (this.outputStream && !this.outputStream.destroyed) {
          this.outputStream.end();
        }

        if (this.passthrough && !this.passthrough.destroyed) {
          this.passthrough.end();
        }

        // Затем убиваем процесс
        this.process.kill(signal);
      } catch (error) {
        // Ignore kill errors
        if (this.config.verbose) {
          this.config.logger.debug?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Kill error: ${error}`,
          );
        }
      }

      if (this.donePromise) {
        try {
          await this.donePromise;
        } catch {
          // ignore
        }
      }

      // Debounce для предотвращения немедленного перезапуска
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
    this._cleanup();
    void this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"));
    this.removeAllListeners();
  }

  /**
   * Build FFmpeg acrossfade filter string with correct syntax.
   * Generates proper filter_complex syntax for audio crossfading.
   *
   * FFmpeg acrossfade works with exactly 2 inputs. For multiple inputs,
   * this method generates cascading crossfades.
   *
   * Examples:
   *  - 2 inputs: [0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[out]
   *  - 3 inputs: [0:a][1:a]acrossfade=d=3[cf1];[cf1][2:a]acrossfade=d=3[out]
   *  - 4 inputs: [0:a][1:a]acrossfade=d=2[cf1];[cf1][2:a]acrossfade=d=2[cf2];[cf2][3:a]acrossfade=d=2[out]
   */
  public static buildAcrossfadeFilter(
    opts: {
      inputs?: number;
      nb_samples?: number;
      duration?: number | string;
      curve1?: string;
      curve2?: string;
      inputLabels?: string[];
      outputLabel?: string;
    } = {},
  ): { filter: string; outputLabel?: string } {
    const inputs = opts.inputs ?? 2;
    const duration = opts.duration ?? 3;
    const curve1 = opts.curve1 ?? "tri";
    const curve2 = opts.curve2 ?? "tri";
    const outputLabel = opts.outputLabel ?? "acf";

    // Validate curves
    const validCurves = [
      "tri",
      "qsin",
      "esin",
      "hsin",
      "log",
      "ipar",
      "qua",
      "cub",
      "squ",
      "cbr",
      "par",
      "exp",
      "iqsin",
      "ihsin",
      "dese",
      "desi",
      "losi",
      "nofade",
    ];

    if (!validCurves.includes(curve1)) {
      throw new Error(`Invalid curve1: ${curve1}. Must be one of: ${validCurves.join(", ")}`);
    }
    if (!validCurves.includes(curve2)) {
      throw new Error(`Invalid curve2: ${curve2}. Must be one of: ${validCurves.join(", ")}`);
    }

    // Build parameters for acrossfade
    const params: string[] = [];
    params.push(`d=${duration}`);
    params.push(`c1=${curve1}`);
    params.push(`c2=${curve2}`);

    if (opts.nb_samples !== undefined) {
      params.push(`ns=${opts.nb_samples}`);
    }

    const paramStr = params.join(":");

    if (inputs === 2) {
      // Simple case: 2 inputs
      // [0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[out]
      const in0 = opts.inputLabels?.[0] ?? "0:a";
      const in1 = opts.inputLabels?.[1] ?? "1:a";
      const filter = `[${in0}][${in1}]acrossfade=${paramStr}[${outputLabel}]`;

      return { filter, outputLabel };
    } else {
      // Multiple inputs: cascading crossfades
      // [0:a][1:a]acrossfade=d=3[cf1];[cf1][2:a]acrossfade=d=3[cf2];...
      const filterParts: string[] = [];
      let prevLabel = "";

      for (let i = 1; i < inputs; i++) {
        const in0Label = i === 1 ? (opts.inputLabels?.[0] ?? "0:a") : prevLabel;
        const in1Label = opts.inputLabels?.[i] ?? `${i}:a`;
        const outLabel = i === inputs - 1 ? outputLabel : `acf_${i}`;

        filterParts.push(`[${in0Label}][${in1Label}]acrossfade=${paramStr}[${outLabel}]`);

        prevLabel = outLabel;
      }

      const filter = filterParts.join(";");
      return { filter, outputLabel };
    }
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
    this._bitrateDetected = false;
    this._startTime = 0;
    this._totalChunks = 0;
    this._skipInProgress = false;
    this._lastSkipTime = 0;

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
    output._ffmpegDrainAttached = true;

    setTimeout(() => {
      if (output.destroyed || output.writableEnded) return;
      if (output.readableFlowing || output.listeners("data").length > 0) return;

      output.pipe(this._getBlackholeStream(), { end: false });

      if (this.config.verbose) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Output drained to prevent backpressure`,
        );
      }
    }, 100);
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
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
    const bytesPerSecond = sampleRate * channels * 2;
    const silenceBytes = Math.floor((durationMs / 1000) * bytesPerSecond);
    const adaptiveChunkSize = Math.min(512, Math.max(128, (this.currentBitrate / 128) * 256));
    const chunkSize = Math.min(adaptiveChunkSize, silenceBytes);
    let silenceSent = 0;

    return new Readable({
      highWaterMark: 4096,
      read() {
        if (silenceSent >= silenceBytes) {
          this.push(null);
          return;
        }

        const remaining = silenceBytes - silenceSent;
        const sendSize = Math.min(chunkSize, remaining);
        const chunk = Buffer.alloc(sendSize, 0);
        this.push(chunk);
        silenceSent += sendSize;
      },
    });
  }

  public createSilenceBuffer(durationMs = 100, sampleRate = 48000, channels = 2): Buffer {
    const bytesPerSample = 2;
    const totalBytes = Math.floor((durationMs / 1000) * sampleRate * channels * bytesPerSample);
    return Buffer.alloc(totalBytes, 0);
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

    // Parse duration
    const durationMatch = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
    if (durationMatch) {
      const hours = parseInt(durationMatch[1]!, 10);
      const minutes = parseInt(durationMatch[2]!, 10);
      const seconds = parseInt(durationMatch[3]!, 10);
      const milliseconds = parseInt(durationMatch[4]!.substring(0, 3), 10);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      this.currentDuration = Math.max(1, Math.min(3600, totalSeconds));

      if (this.config.verbose) {
        this.config.logger.debug?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Detected duration: ${this.currentDuration.toFixed(3)}s`,
        );
      }
    }

    // Parse bitrate (only once)
    if (!this._bitrateDetected) {
      const bitrateMatch = text.match(/bitrate=\s*(\d+(?:\.\d+)?)\s*(k(?:b\/s)?|M(?:b\/s)?)/i);
      if (bitrateMatch) {
        const value = parseFloat(bitrateMatch[1]!);
        const unit = bitrateMatch[2]!.toLowerCase();
        let bitrateKbps = value;

        if (unit.startsWith("m")) {
          bitrateKbps = value * 1000;
        }

        this.currentBitrate = Math.max(32, Math.min(320, bitrateKbps));
        this._bitrateDetected = true;

        if (this.throttledOutput instanceof ThrottleStream) {
          const bytesPerSecond = (this.currentBitrate * 1000) / 8;
          this.throttledOutput.updateBitrate(bytesPerSecond);
        }

        if (this.config.verbose) {
          this.config.logger.info?.(
            `[${getTimeString()}] [${this.config.loggerTag}] Bitrate detected: ${this.currentBitrate} kbps`,
          );
        }
      }
    }

    // Progress tracking
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
    if (this.hasFinished) return;

    if (code === 0 || (signal !== null && this.isTerminating)) {
      if (this.isTerminating) {
        // Задержка перед эмитом события для предотвращения race condition
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

        setImmediate(() => {
          if (this.endSequenceFn && !this._runEmittedEnd) {
            this.endSequenceFn();
          }
        });
      }
    } else {
      const error = this._getProcessExitError(code, signal);
      const tail = this.stderrBuffer.trim().slice(-4000);

      if (tail && this.config.verbose) {
        this.config.logger.error?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`,
        );
      }

      this.emit("error", error);
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

      // Log statistics
      if (this.config.verbose) {
        const duration = (Date.now() - this._startTime) / 1000;
        const expectedDuration = this.currentDuration || 0;
        const ratio = expectedDuration > 0 ? duration / expectedDuration : 0;

        this.config.logger.info?.(
          `[${getTimeString()}] [${this.config.loggerTag}] Playback complete: ` +
            `actual=${duration.toFixed(1)}s, expected=${expectedDuration.toFixed(1)}s, ` +
            `ratio=${ratio.toFixed(2)}, chunks=${this._totalChunks}`,
        );
      }

      this._cleanup();

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
    try {
      this.process?.stdout?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.process?.stderr?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.outputStream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.passthrough?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.blackholeStream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.throttledOutput?.destroy();
    } catch {
      /* ignore */
    }

    for (const { stream } of this.extraOutputs) {
      try {
        stream.destroy();
      } catch {
        /* ignore */
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

  static create(
    params?: {
      args?: string[];
      inputStreams?: Array<{ stream: Readable; index: number }>;
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
    if (workerInputStreams)
      worker.inputStreams = workerInputStreams.map(({ stream, index }) => ({
        stream,
        index,
      }));

    return worker;
  }
}

export default Processor;
