import type { AudioProcessingOptions, InputSource, ProcessorOptions } from "../../Types/index.js";

export type ProcessorConfig = {
  ffmpegPath: string;
  failFast: boolean;
  extraGlobalArgs: string[];
  loggerTag: string;
  inputStreams: Array<{ stream: ReadableStream<Uint8Array>; index: number }>;
  onBeforeChildProcessSpawn?: (ffmpegPath: string, args: string[]) => void;
  stderrLogHandler?: (chunk: string) => void;
  executionId: string;
  wallTimeLimit: number;
  timeout: number;
  maxStderrBuffer: number;
  enableProgressTracking: boolean;
  logger: NonNullable<ProcessorOptions["logger"]>;
  verbose: boolean;
  debug: boolean;
  abortSignal?: AbortSignal;
  headers: Record<string, string> | string;
  userAgent: string;
  disableThrottling: boolean;
  ffmpegLogLevel: NonNullable<ProcessorOptions["ffmpegLogLevel"]>;
  useAudioProcessor: boolean;
  inputSources: InputSource[];
  audioProcessorOptions: AudioProcessingOptions;
  autoDrainOutput: boolean;
};

export function buildProcessorConfig(options: ProcessorOptions = {}): ProcessorConfig {
  return {
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
    abortSignal: options.abortSignal,
    headers: options.headers ?? {},
    userAgent: options.userAgent ?? "Mozilla/5.0 (compatible; FFmpegProcessor/1.0)",
    disableThrottling: options.disableThrottling ?? true,
    ffmpegLogLevel: options.ffmpegLogLevel ?? "info",
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
    autoDrainOutput: options.autoDrainOutput ?? true,
  };
}
