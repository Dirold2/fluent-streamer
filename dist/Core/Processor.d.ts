import { EventEmitter } from "eventemitter3";
import { Readable, Writable } from "stream";
import type { FFmpegRunResult } from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";
/**
 * Class for launching and managing FFmpeg processes, their lifecycle and progress.
 *
 * @example
 * ```typescript
 * import Processor from './Processor';
 * const proc = new Processor({ ffmpegPath: 'ffmpeg' });
 * proc.setArgs(['-i', 'input.mp3', 'output.wav']);
 * const { output, done, stop } = proc.run();
 * output.pipe(fs.createWriteStream('output.wav'));
 * await done;
 * ```
 *
 * @fires Processor#progress
 * @fires Processor#error
 * @fires Processor#end
 * @fires Processor#terminated
 * @fires Processor#start
 * @fires Processor#spawn
 */
export declare class Processor extends EventEmitter {
    private process;
    private outputStream;
    private inputStreams;
    private extraOutputs;
    private stderrBuffer;
    private isTerminating;
    private hasFinished;
    private timeoutHandle?;
    private progress;
    private doneResolve;
    private doneReject;
    private readonly donePromise;
    private readonly config;
    private args;
    private extraGlobalArgs;
    /**
     * Gets the PID of the running FFmpeg process (null if not running).
     */
    get pid(): number | null;
    /**
     * Constructs a Processor object.
     * @param options ProcessorOptions
     */
    constructor(options?: ProcessorOptions);
    /**
     * Sets the FFmpeg argument list.
     * @param args Arguments array (e.g. ['-i', 'input', 'output'])
     * @returns this
     */
    setArgs(args: string[]): this;
    /**
     * Returns the current FFmpeg argument list.
     * @returns Arguments array
     */
    getArgs(): string[];
    /**
     * Sets the input streams for FFmpeg.
     * @param streams Array of objects: { stream, index }
     * @returns this
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Returns FFmpeg's stdin stream if available.
     */
    getInputStream(): NodeJS.WritableStream | undefined;
    /**
     * Sets additional writable outputs for FFmpeg auxiliary pipes (e.g. pipe:2).
     * @param streams Array of objects: { stream, index }
     * @returns this
     */
    setExtraOutputStreams(streams: Array<{
        stream: Writable;
        index: number;
    }>): this;
    /**
     * Sets extra arguments to be prepended globally to the FFmpeg command.
     * @param args Arguments array
     * @returns this
     */
    setExtraGlobalArgs(args: string[]): this;
    /**
     * Returns the complete argument list passed to FFmpeg (extraGlobalArgs + args).
     * @returns Arguments array
     */
    getFullArgs(): string[];
    /**
     * Runs the FFmpeg process using the current options and argument list.
     * Binds IO, process events, progress updates.
     *
     * @returns {{ output: PassThrough, done: Promise<void>, stop: () => void }}
     *
     * @example
     * const proc = new Processor();
     * proc.setArgs(['-i', 'input.mp4', 'output.mp3']);
     * const { output, done, stop } = proc.run();
     * output.pipe(fs.createWriteStream('output.mp3'));
     * await done;
     */
    run(): FFmpegRunResult;
    /**
     * Kills the FFmpeg process.
     * @param signal Signal to send (default: "SIGTERM")
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Builds an "acrossfade" FFmpeg filter string.
     * @param opts Filter options
     * @returns { filter: string, outputLabel?: string }
     * @example
     * Processor.buildAcrossfadeFilter({ duration: 2, curve1: 'exp', curve2: 'sin' });
     */
    static buildAcrossfadeFilter(opts?: {
        inputs?: number;
        nb_samples?: number;
        duration?: number | string;
        overlap?: boolean;
        curve1?: string;
        curve2?: string;
        inputLabels?: string[];
        outputLabel?: string;
    }): {
        filter: string;
        outputLabel?: string;
    };
    /**
     * Returns the FFmpeg command line as string.
     * @returns Command string
     * @example
     * processor.toString(); // "ffmpeg -i foo.mp3 bar.wav"
     */
    toString(): string;
    /**
     * Sets up abort signal support.
     * If abortSignal is triggered, will kill the process.
     * @private
     */
    private _handleAbortSignal;
    /**
     * Sets up process timeout (if timeout > 0).
     * @private
     */
    private _handleTimeout;
    /**
     * Connects the first input stream (if any) to the FFmpeg process stdin.
     * @private
     */
    private _bindInputStream;
    /**
     * Connects process.stdout to outputStream and sets up stderr handling.
     * @private
     */
    private _bindOutputStreams;
    /**
     * Binds process exit/error/close events.
     * @private
     */
    private _bindProcessEvents;
    /**
     * Handles and buffers stderr data for diagnostics and progress tracking.
     * @private
     */
    private _handleStderr;
    /**
     * Handles the process exit logic.
     * @private
     */
    private _onProcessExit;
    /**
     * Formats process exit error with code, signal and last stderr snippet.
     * @private
     */
    private _getProcessExitError;
    /**
     * Finalizes the process state, cleans up, and resolves/rejects as needed.
     * @param error Error, if any
     * @private
     */
    private _finalize;
    /**
     * Cleans up streams used by this process.
     * @private
     */
    private _cleanup;
    /**
     * Parses a single line of FFmpeg progress output.
     * @param line FFmpeg progress line
     * @returns Progress object or null
     * @private
     * @example
     * // frame=882 fps=28.94 ... time=00:00:29.43
     * const progress = processor._parseProgress('frame=100 fps=45.0 ...');
     */
    private _parseProgress;
    /**
     * Creates a Processor instance using argument bag.
     * @param params Processor options, args, inputStreams
     * @returns Processor
     * @example
     * const p = Processor.create({
     *   args: ['-i', 'a.mp4', 'b.mp3'],
     *   inputStreams: [{ stream: s, index: 0 }],
     *   timeout: 5000,
     * });
     */
    static create(params?: {
        args?: string[];
        inputStreams?: Array<{
            stream: Readable;
            index: number;
        }>;
        options?: ProcessorOptions;
    } & ProcessorOptions): Processor;
}
export default Processor;
