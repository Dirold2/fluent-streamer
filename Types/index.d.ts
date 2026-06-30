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
    compressor: boolean;
    normalize: boolean;
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
export type InputSource = {
    type: "stream";
    stream: ReadableStream<Uint8Array>;
    index: number;
} | {
    type: "url";
    url: string;
    index: number;
    headers?: Record<string, string>;
} | {
    type: "blob";
    blobUrl: string;
    index: number;
};
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
    inputStreams?: Array<{
        stream: ReadableStream<Uint8Array>;
        index: number;
    }>;
    inputSources?: InputSource[];
    disableThrottling?: boolean;
    ffmpegLogLevel?: "quiet" | "panic" | "fatal" | "error" | "warning" | "info" | "verbose" | "debug" | "trace";
    tailSilenceMs?: number;
    useAudioProcessor?: boolean;
    audioProcessorOptions?: AudioProcessingOptions;
    autoDrainOutput?: boolean;
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
    stop: () => void;
}
export interface FFmpegRunResultExtended extends FFmpegRunResult {
    passthrough: ReadableStream<Uint8Array>;
    close: () => Promise<void> | void;
    audioProcessor?: AudioProcessor;
    throttledOutput?: ReadableStream<Uint8Array>;
    currentFade?: {
        target: number;
        duration?: number;
    };
    setVolume?: (volume: number) => void;
    setBass?: (bass: number) => void;
    setTreble?: (treble: number) => void;
    setCompressor?: (enabled: boolean) => void;
    setNormalize?: (enabled: boolean) => void;
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
//# sourceMappingURL=index.d.ts.map