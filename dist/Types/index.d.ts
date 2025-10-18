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
    /** Suppress warning for output pipeline "premature close" (treat as benign). */
    suppressPrematureCloseWarning?: boolean;
    /**
     * Optional HTTP headers to pass to ffmpeg for network requests.
     * Either an object of key-value pairs, or the raw string as accepted by ffmpeg.
     */
    headers?: Record<string, string> | string;
}
/**
 * Represents the current progress state of an ffmpeg process, as parsed
 * from key-value updates from ffmpeg's progress output.
 *
 * All fields are optional and may be missing depending on ffmpeg's output.
 */
export interface FFmpegProgress {
    /** Number of frames processed so far */
    frame?: number;
    /** Current processing frames per second */
    fps?: number;
    /** Current output bitrate (e.g., "1700kbits/s") */
    bitrate?: string;
    /** Total size of output file so far, in bytes */
    totalSize?: number;
    /** Output time in microseconds */
    outTimeUs?: number;
    /** Output timestamp as a time string (e.g., "00:01:30.05") */
    outTime?: string;
    /** Number of duplicate frames detected */
    dupFrames?: number;
    /** Number of dropped frames */
    dropFrames?: number;
    /** Current processing speed (e.g., 1 = real time) */
    speed?: number;
    /** Progress marker string ("continue", "end") */
    progress?: string;
}
/**
 * Represents statistics about an ffmpeg process execution.
 *
 * @property {Date} startTime - The timestamp when the ffmpeg process started.
 * @property {Date} [endTime] - The timestamp when the ffmpeg process ended (optional).
 * @property {number} [duration] - The total duration of the ffmpeg process in milliseconds (optional).
 * @property {number} [exitCode] - The exit code returned by the ffmpeg process (optional).
 * @property {string} [signal] - The signal that caused the ffmpeg process to terminate, if any (optional).
 * @property {number} stderrLines - The number of lines output to stderr.
 * @property {number} bytesProcessed - The number of bytes processed during execution.
 */
export interface FFmpegStats {
    /** The timestamp when the ffmpeg process started. */
    startTime: Date;
    /** The timestamp when the ffmpeg process ended (optional). */
    endTime?: Date;
    /** The total duration of the ffmpeg process in milliseconds (optional). */
    duration?: number;
    /** The exit code returned by the ffmpeg process (optional). */
    exitCode?: number;
    /** The signal that caused the ffmpeg process to terminate, if any (optional). */
    signal?: string;
    /** The number of lines output to stderr. */
    stderrLines: number;
    /** The number of bytes processed during execution. */
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
    /** Function to stop the ffmpeg process */
    stop: () => void;
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
