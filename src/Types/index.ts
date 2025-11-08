import { PassThrough, Readable } from "stream";

/** Logger interface for debugging, warnings, errors. */
export interface Logger {
  debug(message: string, meta?: Record<string, any>): void;
  info(message: string, meta?: Record<string, any>): void;
  log(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  error(message: string, meta?: Record<string, any>): void;
}

/** Options for configuring the Processor and its core behavior. */
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
}

/** Progress-reporting interface for ffmpeg. */
export interface FFmpegProgress {
  frame?: number;
  fps?: number;
  bitrate?: string;
  totalSize?: number;
  outTimeUs?: number;
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

/** Statistics on a single ffmpeg process run. */
export interface FFmpegStats {
  startTime: Date;
  endTime?: Date;
  duration?: number;
  exitCode?: number;
  signal?: string;
  stderrLines: number;
  bytesProcessed: number;
}

/** The main result object describing the ffmpeg run. */
export interface FFmpegRunResult {
  output: PassThrough;
  done: Promise<void>;
  stop: () => void;
  on?(event: string, listener: (...args: any[]) => void): this;
}

export interface FFmpegRunResultExtended extends FFmpegRunResult {
  passthrough: PassThrough;
  close: () => void;
}


/** ffmpeg options type that permits string or stream input. */
export interface StreamableFFmpegOptions extends ProcessorOptions {
  input?: string | Readable;
}

/** Information about a queued ffmpeg job. */
export interface FFmpegJob {
  name: string;
  options: StreamableFFmpegOptions;
  resolve: (result: FFmpegRunResult) => void;
  reject: (err: Error) => void;
}

/** Manager/global configuration for ffmpeg job processing. */
export interface FFmpegManagerOptions {
  maxRestarts?: number;
  concurrency?: number;
  logger?: Logger;
  retry?: number;
  autoRestart?: boolean;
}

/** "Processor" interface for core processor public API. */
export interface Processor {
  config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
    debug?: boolean;
    enableProgressTracking?: boolean;
  };

  get pid(): number | null;
  get isRunning(): boolean;
  get isTerminated(): boolean;
  setArgs(args: string[]): void;
  getArgs(): string[];
  run(): FFmpegRunResult;
}
