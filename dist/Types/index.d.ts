import { PassThrough, Readable } from "stream";
/**
 * Logger interface for handling debug, warning, and error messages.
 */
export interface Logger {
    /**
     * Logs a debug message.
     * @param message - The message to log
     * @param meta - Optional metadata associated with the log
     */
    debug(message: string, meta?: Record<string, any>): void;
    /**
     * Logs a warning message.
     * @param message - The message to log
     * @param meta - Optional metadata associated with the log
     */
    warn(message: string, meta?: Record<string, any>): void;
    /**
     * Logs an error message.
     * @param message - The message to log
     * @param meta - Optional metadata associated with the log
     */
    error(message: string, meta?: Record<string, any>): void;
}
/**
 * Options for configuring a SimpleFFmpeg instance.
 */
export interface SimpleFFmpegOptions {
    /** Path to the ffmpeg executable (default: "ffmpeg") */
    ffmpegPath?: string;
    /** Whether to fail fast on errors (default: false) */
    failFast?: boolean;
    /** Additional global ffmpeg arguments */
    extraGlobalArgs?: string[];
    /** Maximum execution time in milliseconds (0 = no timeout) */
    timeout?: number;
    /** Maximum buffer size for stderr (default: 1MB) */
    maxStderrBuffer?: number;
    /** Enable progress tracking via the "progress" event */
    enableProgressTracking?: boolean;
    /** Logger implementation */
    logger?: Logger;
    /** Tag used in log messages */
    loggerTag?: string;
    /** Optional abort signal to terminate the process */
    abortSignal?: AbortSignal;
}
/**
 * Represents the progress of an ffmpeg process.
 */
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
}
/**
 * Statistics about an ffmpeg process execution.
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
 * Result returned from running ffmpeg.
 */
export interface FFmpegRunResult {
    /** Output stream of ffmpeg */
    output: PassThrough;
    /** Promise that resolves when ffmpeg finishes */
    done: Promise<void>;
}
/**
 * Options for ffmpeg jobs that can take a string or stream as input.
 */
export interface StreamableFFmpegOptions extends SimpleFFmpegOptions {
    /** Input source, either a file path or a readable stream */
    input?: string | Readable;
}
/**
 * Represents a single ffmpeg job in the manager queue.
 */
export interface FFmpegJob {
    /** Name of the job */
    name: string;
    /** Options for the job */
    options: StreamableFFmpegOptions;
    /** Callback invoked on successful completion */
    resolve: (result: FFmpegRunResult) => void;
    /** Callback invoked on error */
    reject: (err: Error) => void;
}
/**
 * Configuration options for FFmpegManager.
 */
export interface FFmpegManagerOptions {
    maxRestarts?: number;
    /** Maximum number of concurrent ffmpeg jobs (default: 2) */
    concurrency?: number;
    /** Logger implementation */
    logger?: Logger;
    /** Number of retry attempts for failed jobs (default: 1) */
    retry?: number;
    /** Whether to automatically restart failed jobs (default: false) */
    autoRestart?: boolean;
}
