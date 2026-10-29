import { AudioProcessor } from "../Audio/AudioProcessor.js";

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  log(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string | Error, meta?: LogMeta): void;
}

export interface LogMeta {
  code?: string;
  stackTrace?: string;
  detail?: unknown;
  err?: Error;
  currentArgs?: string[];
  complexFilters?: string[];
}

export interface AudioProcessingOptions {
  volume: number;
  bass: number;
  treble: number;
  mids?: number;
  compressor: boolean;
  normalize: boolean;
  /** Stereo-preserving mid/side center attenuation: side retained, mid shelving at ~180 Hz–6 kHz with nominal -24 dB depth; overall mid/side energy coherence (not per-frequency) reduces suppression on hard-panned signals. Runtime wet ramp: 50 ms; initially enabled: immediate; mono: bypass. Not ML vocal isolation: center instruments may be affected, panned/reverberant vocals may remain; no complete-removal or listening-quality guarantee. Reconstruction may clip even unclipped input; processor saturates. More CPU than simple subtraction. */
  karaoke?: boolean;
  cloneInput?: boolean;

  sampleRate?: number;
  channels?: number;

  headers?: Record<string, string>;
  lowPassFrequency?: number;
  lowPassQ?: number;

  fade?: {
    fadein: number;
    fadeout: number;
  };
}

export type InputSource =
  | { type: "stream"; stream: ReadableStream<Uint8Array>; index: number }
  | {
      type: "url";
      url: string;
      index: number;
      headers?: Record<string, string>;
    }
  | { type: "blob"; blobUrl: string; index: number };

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
  inputStreams?: Array<{ stream: ReadableStream<Uint8Array>; index: number }>;
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

  tailSilenceMs?: number;
  useAudioProcessor?: boolean;
  audioProcessorOptions?: AudioProcessingOptions;
  autoDrainOutput?: boolean;
  /** Stable PCM output for live crossfade; disables auto-drain. Consume output for done to settle. */
  enableCrossfade?: boolean;
}

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

export interface FFmpegStats {
  startTime: Date;
  endTime?: Date;
  duration?: number;

  exitCode?: number;
  signal?: string;

  stderrLines: number;
  bytesProcessed: number;
}

export interface FFmpegRunResult {
  output: ReadableStream<Uint8Array>;
  done: Promise<void>;
  stop: (signal?: string) => void | Promise<void>;
}

/** Opt-in live PCM transition shaping. Defaults preserve the linear crossfade. */
export interface LiveCrossfadeOptions {
  /** Independent band envelopes; beat-handoff maps the overlap to eight beat slots. */
  mode?: "crossfade" | "beat-handoff";
  /** Incoming file position in seconds; no automatic beat/drop detection. */
  startTime?: number;
  curve?: "linear" | "equalPower";
  /** Progressive outgoing low-band attenuation, -60..0 dB (default 0). */
  outgoingBassDb?: number;
  /** Complementary low-band handoff over 35..65% of the fade (default false). */
  bassHandoff?: boolean;
  /** Low-band split frequency, 20..1000 Hz (default 180, below Nyquist). */
  bassCutoffHz?: number;
  /** Headroom at the overlap midpoint, 0..12 dB (default 0); unity at endpoints. */
  headroomDb?: number;
}

export interface FFmpegRunResultExtended extends FFmpegRunResult {
  /**
   * Seek a replayable file/URL to absolute seconds (finite >= 0) or a time string.
   * Ordinary runs restart FFmpeg and return a new result/output/done; replace the
   * consumer and retain the new result. Stale ordinary results reject (unchanged).
   * With enableCrossfade: true, returns the same public result, output, and session
   * done. After a completed crossfade, the position is within the current track,
   * not the original track or mixed-session timeline. Keep output continuously
   * consumed before and throughout await seek(); backpressure can stall completion.
   * External queued player PCM is not flushed. Old frames may continue during
   * decoder warmup, and network startup may cause a gap; gapless is not guaranteed.
   * Rejects during an active fade; while seeking, crossfade and a second seek
   * reject. Operations do not cancel or supersede an in-progress transition.
   */
  seek?: (position: number | string) => Promise<FFmpegRunResultExtended>;
  crossfade?: (url: string, time?: number, options?: LiveCrossfadeOptions) => Promise<void>;
  passthrough: ReadableStream<Uint8Array>;
  close: () => Promise<void> | void;
  audioProcessor?: AudioProcessor;
  throttledOutput?: ReadableStream<Uint8Array>;
  currentFade?: { target: number; duration?: number };
  setVolume?: (volume: number) => void;
  setBass?: (bass: number) => void;
  setTreble?: (treble: number) => void;
  setMids?: (mids: number) => void;
  setCompressor?: (enabled: boolean) => void;
  setNormalize?: (enabled: boolean) => void;
  setKaraoke?: (enabled: boolean) => void;
  startFade?: (targetVolume: number, durationMs: number) => void;
}

export interface StreamableFFmpegOptions extends ProcessorOptions {
  input?: string | ReadableStream<Uint8Array>;
}

export interface FFmpegJob {
  name: string;
  options: StreamableFFmpegOptions;
  resolve: (result: FFmpegRunResult) => void;
  reject: (err: Error) => void;
}

export interface FFmpegManagerOptions {
  maxRestarts?: number;
  concurrency?: number;
  logger?: Logger;
  retry?: number;
  autoRestart?: boolean;
}

export interface ProcessorDebugInfo {
  pid: number | null;
  args: string[];
  fullArgs: string[];

  state?: "idle" | "running" | "terminating" | "finished" | "failed" | "closed";
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

export interface CrossfadeAudioOptions {
  secondInput?: string | ReadableStream<Uint8Array>;
  inputs?: number;
  curve1?: string;
  curve2?: string;
  inputLabels?: string[];
  outputLabel?: string;
  extra?: string;
}
