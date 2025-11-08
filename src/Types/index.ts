import { PassThrough, Readable } from "stream";
import { AudioProcessor } from "../Core/AudioProcessor.js";

/** Unified logging interface used across Processor and FluentStream. */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  log(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string | Error, meta?: LogMeta): void;
}

/** Metadata for logging operations */
export interface LogMeta {
  code?: string;
  stackTrace?: string;
  detail?: unknown;
  err?: Error;
  currentArgs?: string[];
  complexFilters?: string[];
}

/**
 * Configuration for audio post-processing chain (AudioProcessor).
 * All numeric values are normalized (0–1 or dB ranges where applicable).
 */
export interface AudioProcessingOptions {
  volume: number;
  bass: number;
  treble: number;
  compressor: boolean;
  normalize: boolean;
  headers?: Record<string, string>;
  lowPassFrequency?: number;
  lowPassQ?: number;
  fade?: {
    fadein: number;
    fadeout: number;
  };
}

/**
 * Global ffmpeg & processor configuration.
 * Defines runtime behavior, logging, error handling and integration flags.
 */
export interface ProcessorOptions {
  ffmpegPath?: string;
  failFast?: boolean;
  extraGlobalArgs?: string[];
  timeout?: number;
  maxStderrBuffer?: number;
  enableProgressTracking?: boolean;
  logger?: Logger;
  debug?: boolean;
  loggerTag?: string;
  abortSignal?: AbortSignal;
  suppressPrematureCloseWarning?: boolean;
  wallTimeLimit?: number;
  executionId?: string;
  onBeforeChildProcessSpawn?: (ffmpegPath: string, ffmpegArgs: string[]) => void | Promise<void>;
  stderrLogHandler?: (line: string) => void;
  headers?: Record<string, string> | string;
  inputStreams?: Array<{ stream: Readable; index: number }>;
  verbose?: boolean;
  disableThrottling?: boolean;
  
  /** Enables AudioProcessor usage and configures its chain. */
  useAudioProcessor?: boolean;
  audioProcessorOptions?: AudioProcessingOptions;
}

/** Real-time ffmpeg progress structure (parsed from stderr). */
export interface FFmpegProgress {
  frame?: number;
  fps?: number;
  bitrate?: string;
  totalSize?: number;
  outTimeUs?: number;
  outTimeMs?: number;
  outTime?: string;
  dupFrames?: number;
  dropFrames?: number;
  speed?: number;
  progress?: string;
  size?: string;
  time?: string;
  packet?: number;
  chapter?: number;
}

/** Statistics about a single ffmpeg execution session. */
export interface FFmpegStats {
  startTime: Date;
  endTime?: Date;
  duration?: number;
  exitCode?: number;
  signal?: string;
  stderrLines: number;
  bytesProcessed: number;
}

/** Minimal result of a Processor run (used for basic chaining). */
export interface FFmpegRunResult {
  output: PassThrough;
  done: Promise<void>;
  stop: () => void;
}

/** Extended Processor result with full audio control and lifecycle management. */
export interface FFmpegRunResultExtended extends FFmpegRunResult {
  passthrough: PassThrough;
  close: () => Promise<void> | void;
  /** AudioProcessor instance, if enabled. */
  audioProcessor?: AudioProcessor;
  /** Current fade state, if any. */
  currentFade?: { target: number; duration?: number };
  /**
   * Audio effects control API (only present if AudioProcessor enabled).
   */
  setVolume?: (volume: number) => void;
  setBass?: (bass: number) => void;
  setTreble?: (treble: number) => void;
  setCompressor?: (enabled: boolean) => void;
  setEqualizer?: (bass: number, treble: number, compressor: boolean) => void;
  startFade?: (targetVolume: number, durationMs: number) => void;
}

/** ffmpeg execution configuration (input can be stream or string). */
export interface StreamableFFmpegOptions extends ProcessorOptions {
  input?: string | Readable;
}

/** Job queued for execution by the ProcessorManager. */
export interface FFmpegJob {
  name: string;
  options: StreamableFFmpegOptions;
  resolve: (result: FFmpegRunResult) => void;
  reject: (err: Error) => void;
}

/** Global settings for managing ffmpeg jobs (retry, concurrency, etc). */
export interface FFmpegManagerOptions {
  maxRestarts?: number;
  concurrency?: number;
  logger?: Logger;
  retry?: number;
  autoRestart?: boolean;
}

/** Debug information returned by Processor.debugDump() */
export interface ProcessorDebugInfo {
  pid: number | null;
  args: string[];
  fullArgs: string[];
  isClosed: boolean;
  hasFinished: boolean;
  isTerminating: boolean;
  running: boolean;
  runEnded: boolean;
  runEmittedEnd: boolean;
  extraGlobalArgs: string[];
  stderrBufferLength: number;
  timeoutHandle: boolean;
  progress: Partial<FFmpegProgress>;
  inputStreamsCount: number;
  extraOutputsCount: number;
  timestamp: string;
}

/** Processor public API (low-level ffmpeg orchestration). */
export interface Processor {
  config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
    debug?: boolean;
    enableProgressTracking?: boolean;
    useAudioProcessor?: boolean;
    audioProcessorOptions?: AudioProcessingOptions;
  };

  /** Lifecycle & state getters */
  readonly pid: number | null;
  readonly isRunning: boolean;
  readonly isTerminated: boolean;

  /** ffmpeg argument management */
  setArgs(args: string[]): void;
  getArgs(): string[];

  /** Audio processor configuration */
  setAudioProcessorOptions(opts: AudioProcessingOptions): this;
  enableAudioProcessor(enable: boolean): this;

  /** Start ffmpeg + optional AudioProcessor chain */
  run(): FFmpegRunResultExtended;

  /** Graceful shutdown and cleanup */
  close(): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  destroy(): void;

  /** Debug helpers */
  debugDump(): ProcessorDebugInfo;
}
