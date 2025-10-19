import { EventEmitter } from "eventemitter3";
import { Readable, Writable } from "stream";
import type { FFmpegRunResult } from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";
/**
 * A class for spawning and managing FFmpeg processes, including progress,
 * lifecycle, killing by signal, and stream throttling for realtime output simulation.
 *
 * ### Features
 * - Stream input and output support
 * - Progress reporting and buffer management
 * - Realtime throttling for PCM/raw output formats (for "broadcast" simulation)
 * - Custom logger support
 * - AbortSignal-based cancellation and timeouts
 *
 * ### Usage Example
 * ```ts
 * import Processor from "./Core/Processor";
 * import { createReadStream } from "fs";
 *
 * const proc = new Processor({
 *   ffmpegPath: "/usr/bin/ffmpeg",
 *   enableProgressTracking: true,
 *   debug: true,
 *   timeout: 10000,
 * });
 *
 * proc.setArgs([
 *   "-f", "mp3",
 *   "-i", "pipe:0",
 *   "-f", "s16le",
 *   "-ar", "44100",
 *   "-ac", "2",
 *   "pipe:1"
 * ]);
 *
 * proc.setInputStreams([{ stream: createReadStream("input.mp3"), index: 0 }]);
 *
 * const { output, done, stop } = proc.run();
 * output.pipe(process.stdout);
 *
 * proc.on("progress", (info) => {
 *   console.log("FFmpeg progress", info);
 * });
 *
 * done
 *   .then(() => {
 *     console.log("Process finished.");
 *   })
 *   .catch((err) => {
 *     console.error("Process error:", err);
 *   });
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
     * Returns the PID of the FFmpeg process, or null if not running.
     */
    get pid(): number | null;
    /**
     * Constructs a Processor instance.
     * @param options - FFmpeg related options and configuration.
     */
    constructor(options?: ProcessorOptions);
    /**
     * Set the arguments for FFmpeg process (excluding global extra args).
     * @param args - Arguments array for FFmpeg.
     */
    setArgs(args: string[]): this;
    /**
     * Returns a copy of the current argument list (excluding extra global args).
     */
    getArgs(): string[];
    /**
     * Set one or more input streams for FFmpeg. Pass an array of
     * `{ stream: Readable, index: number }` (index is used for complex FFmpeg invocations).
     *
     * @param streams - Array describing the input streams for FFMpeg.
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Returns the running process's stdin writable stream, if available.
     */
    getInputStream(): NodeJS.WritableStream | undefined;
    /**
     * Optional: Set extra output streams (not implemented in _bindOutputStreams yet).
     * Intended for writing to multiple output destinations.
     * @param streams - Array describing additional outputs.
     */
    setExtraOutputStreams(streams: Array<{
        stream: Writable;
        index: number;
    }>): this;
    /**
     * Overwrite extra global arguments (prepended to FFmpeg args).
     * @param args - Arguments that go before main ffmpeg args.
     */
    setExtraGlobalArgs(args: string[]): this;
    /**
     * Returns the complete list of arguments passed to FFmpeg, including global args.
     */
    getFullArgs(): string[];
    /**
     * Creates a realtime-throttled PassThrough stream to limit PCM/raw stream data rate.
     * Used to simulate "live" streaming of PCM format output.
     *
     * @param sampleRate - PCM sample rate (Hz). Default: 44100 Hz.
     * @param bits - PCM bit depth per sample. Default: 16.
     * @param channels - Number of channels. Default: 2.
     * @returns A throttled PassThrough stream.
     */
    private _createRealtimeThrottleStream;
    /**
     * Launches the FFmpeg process with the currently set arguments and input streams.
     * If output is PCM or similar format, applies a realtime throttle to the output.
     *
     * @returns Object with { output, done, stop }:
     *   - output: ReadableStream for the FFmpeg stdout.
     *   - done: Promise resolved on process completion or rejected on error.
     *   - stop(): Function to kill the process.
     *
     * @example
     * const proc = new Processor({...}).setArgs([...]).run()
     * proc.output.pipe(fs.createWriteStream("output.pcm"))
     */
    run(): FFmpegRunResult;
    /**
     * Kills the underlying FFmpeg process, sending a signal (default: SIGTERM).
     * @param signal - Node.js signal string (e.g. "SIGTERM")]
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Build the acrossfade FFmpeg filter string.
     * Useful for audio cross-fading operations.
     *
     * @param opts - Filter options.
     * @returns Object with filter string and (optional) outputLabel.
     *
     * @example
     * Processor.buildAcrossfadeFilter({duration: 3, curve1: "exp", curve2: "exp"})
     * // { filter: "acrossfade=d=3:c1=exp:c2=exp" }
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
     * Returns CLI invocation string.
     */
    toString(): string;
    /** Bind abort signal, if provided, to kill on abort. */
    private _handleAbortSignal;
    /** Handles timeout by killing FFmpeg if the configured timeout is reached. */
    private _handleTimeout;
    /** Binds a user-provided input stream to the FFmpeg process stdin. */
    private _bindInputStream;
    /**
     * Decide if output stream needs throttling; if so, wrap it in a throttling stream.
     * This applies to raw/pcm-like outputs (e.g. "-f s16le").
     *
     * @param applyThrottlePCM - If true, analyze arguments to possibly enable output throttling.
     */
    private _bindOutputStreams;
    /** Bind process-level events for cleanup and reporting. */
    private _bindProcessEvents;
    /** Handles progress-parsing and stderr buffer management. */
    private _handleStderr;
    /** Handles process exit, cleans up, and emits appropriate events. */
    private _onProcessExit;
    /**
     * Create an Error describing FFmpeg process exit with useful stderr output included.
     */
    private _getProcessExitError;
    /**
     * Final cleanup: stop timeouts, release streams, resolve/reject the done promise.
     * @param error - Error to reject with (optional; otherwise will resolve).
     */
    private _finalize;
    /**
     * Cleanup resources/streams. Always called on process completion.
     */
    private _cleanup;
    /**
     * Attempts to parse a single FFmpeg progress line into a FFmpegProgress object.
     * @param line - FFmpeg stderr output line.
     * @returns Partial FFmpegProgress info (or null if no recognized keys).
     */
    private _parseProgress;
    /**
     * Create a Processor instance with quick-style options for convenience.
     *
     * @example
     * Processor.create({
     *   args: ["-i", "input.mp3", ...],
     *   options: { ffmpegPath: "/usr/bin/ffmpeg" }
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
