import { PassThrough, Readable, Transform } from "stream";
import { AudioProcessor } from "../Core/AudioProcessor.js";

/**
 * Unified logging interface used across Processor and any higher-level wrappers.
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  log(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string | Error, meta?: LogMeta): void;
}

/**
 * Optional structured metadata sent with log messages.
 */
export interface LogMeta {
  code?: string;
  stackTrace?: string;
  detail?: unknown;
  err?: Error;
  currentArgs?: string[];
  complexFilters?: string[];
}

/**
 * Configuration for audio post‑processing chain (AudioProcessor).
 * Все значения в «юзерских» единицах (0–1 или условные dB‑слайдеры),
 * нормализация в реальные коэффициенты происходит внутри AudioProcessor.
 */
export interface AudioProcessingOptions {
  volume: number; // 0–1
  bass: number; // -1..1 (или любая твоя шкала, маппится через normalizeBass)
  treble: number; // -1..1
  compressor: boolean;
  normalize: boolean;

  sampleRate?: number; // Hz (default: 48000)
  channels?: number; // 1=mono, 2=stereo (default: 2)

  headers?: Record<string, string>;
  lowPassFrequency?: number;
  lowPassQ?: number;

  fade?: {
    fadein: number; // ms
    fadeout: number; // ms
  };
}

/**
 * Input source type: stream, URL, or blob
 * Тип входного источника: поток, URL или blob
 */
export type InputSource =
  | { type: "stream"; stream: Readable; index: number }
  | {
      type: "url";
      url: string;
      index: number;
      headers?: Record<string, string>;
    }
  | { type: "blob"; blobUrl: string; index: number };

/**
 * Global ffmpeg & processor configuration.
 * Определяет путь к ffmpeg, логирование, лимиты и т.д.
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
  verbose?: boolean;
  stdoutlog?: boolean;
  loggerTag?: string;

  abortSignal?: AbortSignal;
  suppressPrematureCloseWarning?: boolean;

  wallTimeLimit?: number;
  executionId?: string;

  onBeforeChildProcessSpawn?: (ffmpegPath: string, ffmpegArgs: string[]) => void | Promise<void>;

  stderrLogHandler?: (line: string) => void;

  headers?: Record<string, string> | string;
  userAgent?: string;
  inputStreams?: Array<{ stream: Readable; index: number }>;
  inputSources?: InputSource[];

  disableThrottling?: boolean;

  ffmpegLogLevel?:
    | "quiet"
    | "panic"
    | "fatal"
    | "error"
    | "warning"
    | "info"
    | "verbose"
    | "debug"
    | "trace";

  /**
   * Длительность «хвостовой тишины» в конце стрима (ms) для чистого завершения.
   * Реализовано в Processor через tailSilenceMs.
   */
  tailSilenceMs?: number;

  /** Включает использование AudioProcessor и его начальную конфигурацию. */
  useAudioProcessor?: boolean;
  audioProcessorOptions?: AudioProcessingOptions;
}

/**
 * Real‑time ffmpeg progress (parsed from stderr).
 */
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

/**
 * Statistics about a single ffmpeg execution session.
 */
export interface FFmpegStats {
  startTime: Date;
  endTime?: Date;
  duration?: number;

  exitCode?: number;
  signal?: string;

  stderrLines: number;
  bytesProcessed: number;
}

/**
 * Minimal result of a Processor run (base for chaining).
 */
export interface FFmpegRunResult {
  /** Основной выходной поток (PCM / то, что идёт в Discord и т.п.). */
  output: PassThrough;

  /** Promise, который резолвится при нормальном завершении и реджектится при ошибке. */
  done: Promise<void>;

  /** Мягкая остановка процесса (SIGTERM/kill внутри Processor). */
  stop: () => void;
}

/**
 * Extended Processor result with full audio control and lifecycle management.
 */
export interface FFmpegRunResultExtended extends FFmpegRunResult {
  /** Тот же PassThrough, что и output; оставлен для обратной совместимости. */
  passthrough: PassThrough;

  /** Грейсфул‑закрытие пайплайна (end + kill + ожидание done). */
  close: () => Promise<void> | void;

  /** AudioProcessor instance, если включён useAudioProcessor. */
  audioProcessor?: AudioProcessor;

  /** Поток после ThrottleStream (ограничение байтов/сек для реального времени). */
  throttledOutput?: Transform;

  /** Текущее состояние fade (если запущен). */
  currentFade?: { target: number; duration?: number };

  /** Audio effects control API (если AudioProcessor активен). */
  setVolume?: (volume: number) => void;
  setBass?: (bass: number) => void;
  setTreble?: (treble: number) => void;
  setCompressor?: (enabled: boolean) => void;
  setEqualizer?: (bass: number, treble: number, compressor: boolean) => void;
  startFade?: (targetVolume: number, durationMs: number) => void;
}

/**
 * ffmpeg execution options where input can be либо URL/путь, либо Readable‑стрим.
 * Если используешь наш Processor, обычно передаёшь только inputStreams, а не input.
 */
export interface StreamableFFmpegOptions extends ProcessorOptions {
  input?: string | Readable;
}

/**
 * Job queued for execution by some внешнего FFmpegManager.
 */
export interface FFmpegJob {
  name: string;
  options: StreamableFFmpegOptions;
  resolve: (result: FFmpegRunResult) => void;
  reject: (err: Error) => void;
}

/**
 * Global settings for managing ffmpeg jobs (retry, concurrency, etc).
 * Сам менеджер у тебя пока не реализован — это интерфейс под будущее.
 */
export interface FFmpegManagerOptions {
  maxRestarts?: number;
  concurrency?: number;
  logger?: Logger;
  retry?: number;
  autoRestart?: boolean;
}

/**
 * Debug information returned by Processor.debugDump().
 */
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

/**
 * Options for crossfadeAudio helper.
 * Опции для helper-функции crossfadeAudio.
 */
export interface CrossfadeAudioOptions {
  /** Second input URL or Readable stream */
  secondInput?: string | Readable;

  /** Number of inputs to crossfade (default: 2) */
  inputs?: number;

  /**
   * Curve for fading out first stream (default: 'tri')
   * Valid values: tri, qsin, esin, hsin, log, ipar, qua, cub, squ, cbr, par, exp, iqsin, ihsin, dese, desi, losi, nofade
   */
  curve1?: string;

  /**
   * Curve for fading in second stream (default: 'tri')
   * Valid values: tri, qsin, esin, hsin, log, ipar, qua, cub, squ, cbr, par, exp, iqsin, ihsin, dese, desi, losi, nofade
   */
  curve2?: string;

  /** Custom input labels (e.g., ['0:a', '1:a']) */
  inputLabels?: string[];

  /** Output label for the crossfaded audio (default: 'acf') */
  outputLabel?: string;

  /** Extra filters to apply after crossfade (as separate filter chain) */
  extra?: string;
}

// Processor and AudioProcessor classes are exported from src/Core/index.ts
