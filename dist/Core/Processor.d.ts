/**
 * Low-level FFmpeg process runner.
 *
 * This class is responsible for spawning the FFmpeg process, wiring stdin/stdout/stderr,
 * handling timeouts and termination, and emitting lifecycle/progress events.
 * It does not implement a fluent API and does not depend on the fluent wrapper.
 *
 * @fires Processor#start
 * @fires Processor#spawn
 * @fires Processor#progress
 * @fires Processor#end
 * @fires Processor#error
 * @fires Processor#terminated
 */
import { EventEmitter } from "eventemitter3";
import { type Readable } from "stream";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "../Types/index.js";
/**
 * @typedef {object} ProcessorOptions
 * @augments SimpleFFmpegOptions
 */
export interface ProcessorOptions extends SimpleFFmpegOptions {
}
/**
 * The FFmpeg process runner, responsible for running, controlling, and emitting events for an FFmpeg subprocess.
 * @class
 * @extends EventEmitter
 */
export declare class Processor extends EventEmitter {
    /**
     * Underlying FFmpeg process, or null if not started yet.
     * @private
     * @type {Subprocess | null}
     */
    private process;
    /**
     * Output stream from ffmpeg.
     * @private
     * @type {PassThrough | null}
     */
    private outputStream;
    /**
     * Input streams for ffmpeg with associated indices.
     * @private
     * @type {Array<{ stream: Readable; index: number }>}
     */
    private inputStreams;
    /**
     * Captured stderr buffer.
     * @private
     * @type {string}
     */
    private stderrBuffer;
    /**
     * Is the process terminating.
     * @private
     * @type {boolean}
     */
    private isTerminating;
    /**
     * Has the process finished.
     * @private
     * @type {boolean}
     */
    private finished;
    /**
     * Process timeout timer.
     * @private
     * @type {NodeJS.Timeout | undefined}
     */
    private timeoutHandle?;
    /**
     * Internal resolve for done promise.
     * @private
     */
    private doneResolve;
    /**
     * Internal reject for done promise.
     * @private
     */
    private doneReject;
    /**
     * Done promise, resolves or rejects when process ends.
     * @private
     * @readonly
     */
    private readonly donePromise;
    /**
     * Complete static configuration.
     * @private
     * @readonly
     */
    private readonly config;
    /**
     * PID of FFmpeg process. May be null if process has not started.
     * @readonly
     */
    readonly pid: number | null;
    /**
     * Arguments for ffmpeg.
     * @private
     */
    private args;
    /**
     * Creates a new Processor instance.
     * @param {ProcessorOptions} [options] - FFmpeg process and runner options.
     */
    constructor(options?: ProcessorOptions);
    /**
     * Set the FFmpeg argument list.
     * @param {string[]} args
     * @returns {this}
     */
    setArgs(args: string[]): this;
    /**
     * Set the input streams for ffmpeg (for stdin piping).
     * @param {Array<{ stream: Readable, index: number }>} streams
     * @returns {this}
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Launches the FFmpeg subprocess with the preset arguments and streams.
     * Also wires up output/pipeline, progress tracking and events.
     *
     * @throws {Error} If already running.
     * @returns {FFmpegRunResult} FFmpeg output and process done promise.
     * @fires Processor#start
     * @fires Processor#spawn
     */
    run(): FFmpegRunResult;
    /**
     * Forcefully terminate the ffmpeg process.
     * @param {NodeJS.Signals} [signal="SIGTERM"] Signal to send to child process.
     * @returns {void}
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Returns the full CLI command as a string.
     * @returns {string}
     */
    toString(): string;
    /**
     * Get a copy of the current ffmpeg argument array.
     * @returns {string[]}
     */
    getArgs(): string[];
    /**
     * Promise that resolves on process end, or rejects on error.
     * @readonly
     * @returns {Promise<void>}
     */
    get done(): Promise<void>;
    /**
     * The ffmpeg subprocess stdout stream.
     * @readonly
     * @throws {Error} If process not yet started or stream is missing.
     * @returns {Readable}
     */
    get stdout(): Readable;
    /**
     * Attach abortSignal handling, if provided in options.
     * @private
     */
    private setupAbortSignal;
    /**
     * Apply global/initial ffmpeg args from config.
     * @private
     */
    private applyInitialArgs;
    /**
     * Setup a timeout trigger if configured.
     * @private
     */
    private setupTimeout;
    /**
     * Connect input stream(s) to ffmpeg stdin.
     * @private
     */
    private setupInputStreams;
    /**
     * Setup output (stdout) and stderr event wiring to forward/pipe.
     * @private
     */
    private setupOutputStreams;
    /**
     * Setup non-stream process events (exit, error, cancel).
     * @private
     */
    private setupProcessEvents;
    /**
     * Handle incoming stderr data from ffmpeg and emit progress if enabled.
     * @private
     * @param {Buffer} chunk
     */
    private handleStderrData;
    /**
     * Handle process exit/termination.
     * @private
     * @param {number|null} code
     * @param {NodeJS.Signals|null} signal
     */
    private handleProcessExit;
    /**
     * Construct an Error object for FFmpeg exit with code/signal and stderr snippet.
     * @private
     * @param {number|null} code
     * @param {NodeJS.Signals|null} signal
     * @returns {Error}
     */
    private createExitError;
    /**
     * Trigger done promise resolution/rejection only once.
     * @private
     * @param {Error} [error]
     */
    private finish;
    /**
     * Safely destroy streams and process fds.
     * @private
     */
    private cleanup;
    /**
     * Parse FFmpeg "-progress"-formatted key=value line to progress object.
     * @private
     * @param {string} line
     * @returns {Partial<FFmpegProgress> | null}
     */
    private parseProgress;
    /**
     * Determines if an error should be considered "ignorable" for our pipeline/stream error handling.
     * This includes EPIPE and also 'ERR_STREAM_PREMATURE_CLOSE' code and their message variants.
     *
     * @private
     * @param {any} error - The error object (stream/process error).
     * @returns {boolean} True if the error is considered safe to ignore.
     */
    private isIgnorableError;
}
export default Processor;
