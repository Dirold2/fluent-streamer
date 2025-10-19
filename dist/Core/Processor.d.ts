import { EventEmitter } from "eventemitter3";
import { Readable, Writable } from "stream";
import type { FFmpegRunResult } from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";
/**
 * Processor launches FFmpeg processes and manages their IO streams,
 * progress tracking, timeouts, and lifecycle events for robust orchestration.
 *
 * @example
 * ```ts
 * const worker = new Processor({ ffmpegPath: "/usr/bin/ffmpeg", loggerTag: "my-tag" });
 * worker.setArgs(["-i", "input.wav", "output.mp3"]);
 * const { output, done, stop } = worker.run();
 *
 * output.pipe(fs.createWriteStream("output.mp3"));
 *
 * done.then(() => {
 *   console.log("Processing completed!");
 * }).catch(console.error);
 *
 * // To stop early:
 * // stop();
 * ```
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
     * Returns the current child process id (pid) or null if the process is not running.
     *
     * @example
     * const pid = worker.pid;
     */
    get pid(): number | null;
    /**
     * Creates a new ProcessorWorker.
     *
     * @param options ProcessorOptions (all are optional)
     *
     * @example
     * const worker = new ProcessorWorker({ ffmpegPath: "/usr/bin/ffmpeg" });
     */
    constructor(options?: ProcessorOptions);
    /**
     * Sets the main arguments for ffmpeg.
     * This will override existing arguments.
     *
     * @param args Array of string arguments (e.g., ["-i", "input.wav", "output.mp3"])
     * @returns this
     *
     * @example
     * worker.setArgs(["-i", "input.wav", "output.mp3"]);
     */
    setArgs(args: string[]): this;
    /**
     * Returns a copy of the set ffmpeg arguments (excluding global args).
     *
     * @returns string[]
     *
     * @example
     * console.log(worker.getArgs());
     */
    getArgs(): string[];
    /**
     * Sets input streams to be used as ffmpeg inputs.
     *
     * @param streams Array of objects with .stream (Readable) and .index (input index)
     * @returns this
     *
     * @example
     * worker.setInputStreams([{ stream: fs.createReadStream("foo.wav"), index: 0 }]);
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Returns the writable ffmpeg input stream (stdin),
     * or undefined if process isn't running, or no stdin.
     *
     * @returns NodeJS.WritableStream | undefined
     *
     * @example
     * // After .run()
     * const stdin = worker.getInputStream();
     */
    getInputStream(): NodeJS.WritableStream | undefined;
    /**
     * Sets extra output streams (e.g., for ffmpeg pipe:2/3...).
     *
     * @param streams Array of objects with .stream (Writable) and .index (output index)
     * @returns this
     *
     * @example
     * worker.setExtraOutputStreams([{ stream: someWritable, index: 2 }]);
     */
    setExtraOutputStreams(streams: Array<{
        stream: Writable;
        index: number;
    }>): this;
    /**
     * Sets extra global ffmpeg arguments (e.g., ["-hide_banner"]).
     *
     * @param args Array of string arguments
     * @returns this
     *
     * @example
     * worker.setExtraGlobalArgs(["-hide_banner"]);
     */
    setExtraGlobalArgs(args: string[]): this;
    /**
     * Returns the full ffmpeg argument list including global args and main args.
     *
     * @returns string[]
     *
     * @example
     * console.log(worker.getFullArgs());
     */
    getFullArgs(): string[];
    /**
     * Runs the ffmpeg process according to current arguments and options.
     * Returns handles to output stream, a promise for completion, and stop function.
     *
     * @returns {FFmpegRunResult}
     *
     * @example
     * const { output, done, stop } = worker.run();
     * output.on("data", chunk => /* do something *\/);
     * done.then(() => console.log("Done!"));
     * // stop(); // to cancel early
     */
    run(): FFmpegRunResult;
    /**
     * Kills the running ffmpeg process (if any) with the specified signal.
     *
     * @param signal NodeJS.Signals (default: "SIGTERM")
     *
     * @example
     * worker.kill(); // Sends SIGTERM
     * worker.kill("SIGKILL");
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Builds an ffmpeg 'acrossfade' filter string with the given options.
     * Returns { filter, outputLabel }.
     *
     * @param opts Configuration for acrossfade (duration, curves, nb_samples, outputLabel, etc.)
     * @returns Object with 'filter' (string) and optional 'outputLabel' (string)
     *
     * @example
     * const result = ProcessorWorker.buildAcrossfadeFilter({ duration: 2.5, curve1: 'exp', outputLabel: "end" });
     * // result.filter -> 'acrossfade=d=2.5:c1=exp:c2=tri[end]'
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
     * Returns a human-readable ffmpeg command line for this worker.
     *
     * @returns string
     *
     * @example
     * console.log(worker.toString()); // e.g. "ffmpeg -i input.wav output.mp3"
     */
    toString(): string;
    private _handleAbortSignal;
    private _handleTimeout;
    private _bindInputStream;
    private _bindOutputStreams;
    private _bindProcessEvents;
    private _handleStderr;
    private _onProcessExit;
    private _getProcessExitError;
    private _finalize;
    private _cleanup;
    /**
     * Parse progress information from lines like "key1=val1 key2=val2".
     *
     * @private
     */
    private _parseProgress;
    /**
     * Factory shortcut to create and configure a ProcessorWorker instance.
     *
     * @param params Object possibly including args, inputStreams, options, and/or any ProcessorOptions directly
     * @returns ProcessorWorker
     *
     * @example
     * // All-in-one .create usage:
     * const worker = ProcessorWorker.create({
     *   args: ['-i', 'a.wav', 'b.mp3'],
     *   inputStreams: [{ stream: fs.createReadStream('a.wav'), index: 0 }],
     *   ffmpegPath: '/usr/bin/ffmpeg',
     *   loggerTag: 'complexCase'
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
