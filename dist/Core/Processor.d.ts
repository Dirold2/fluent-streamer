import { EventEmitter } from "eventemitter3";
import { type Readable } from "stream";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "../Types/index.js";
export interface ProcessorOptions extends SimpleFFmpegOptions {
}
/**
 * Low-level FFmpeg process executor.
 * Responsible for starting, managing, and emitting process lifecycle events.
 * This is a "raw" executor and does not add arguments on its own.
 *
 * @example <caption>Basic usage</caption>
 * ```ts
 * import Processor from "./Processor";
 * import { Readable } from "stream";
 *
 * // Prepare input stream with audio data
 * const input = Readable.from(getRawPcmAudioDataSomehow());
 *
 * // Instantiate processor
 * const proc = new Processor({
 *   ffmpegPath: "ffmpeg",
 *   timeout: 20000,
 *   loggerTag: "demo",
 *   enableProgressTracking: true,
 * });
 *
 * // Set arguments and input streams
 * proc.setArgs([
 *   "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
 *   "-f", "wav", "pipe:1"
 * ]);
 * proc.setInputStreams([{stream: input, index: 0}]);
 *
 * // Listen for process events (optional)
 * proc.on("progress", (progress) => {
 *   console.log("Progress:", progress);
 * });
 * proc.on("end", () => {
 *   console.log("Process finished!");
 * });
 *
 * // Start FFmpeg
 * const { output, done, stop } = proc.run();
 * output.on("data", chunk => { * handle WAV data * });
 * await done;
 * ```
 *
 * @example <caption>Handling errors and manual stop</caption>
 * ```ts
 * const { output, done, stop } = proc.run();
 * done.catch((err) => {
 *   console.error("Process error:", err);
 * });
 * setTimeout(() => stop(), 5000); // Kill process after 5 seconds
 * ```
 *
 * @fires Processor#"start" - Emitted when FFmpeg process starts (with command string)
 * @fires Processor#"spawn" - Emitted when FFmpeg process actually spawns ({ pid })
 * @fires Processor#"progress" - Emitted with progress info, if enabled
 * @fires Processor#"error" - Emitted on error
 * @fires Processor#"end" - Emitted on clean process exit
 * @fires Processor#"terminated" - Emitted when forcibly killed (with signal)
 */
export declare class Processor extends EventEmitter {
    private process;
    private outputStream;
    private inputStreams;
    private stderrBuffer;
    private isTerminating;
    private hasFinished;
    private timeoutHandle?;
    private doneResolve;
    private doneReject;
    private readonly donePromise;
    private readonly config;
    readonly pid: number | null;
    private args;
    constructor(options?: ProcessorOptions);
    /**
     * Set the command-line arguments for FFmpeg.
     * @param args The ffmpeg argument array (excluding executable).
     * @returns this
     * @example
     * proc.setArgs(["-i", "pipe:0", "-f", "mp3", "pipe:1"]);
     */
    setArgs(args: string[]): this;
    /**
     * Get a copy of the FFmpeg arguments for this Processor.
     */
    getArgs(): string[];
    /**
     * Set the process input streams.
     * @param streams An array of objects with .stream (Readable) and .index
     * @returns this
     * @example
     * proc.setInputStreams([{ stream: myInput, index: 0 }]);
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Start the FFmpeg process.
     * @returns FFmpegRunResult containing output stream, done promise, and a stop method.
     * @throws If the process is already running.
     *
     * @example
     * const { output, done, stop } = proc.run();
     * output.on("data", chunk => { ... }); // handle output
     * await done;
     * stop(); // gracefully stop (if not already finished)
     */
    run(): FFmpegRunResult;
    /**
     * Send a signal to terminate the FFmpeg process.
     * @param signal The signal to send (default SIGTERM)
     * @example
     * proc.kill(); // send SIGTERM
     * proc.kill("SIGKILL");
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Get a string representation of the full ffmpeg command.
     * @returns The ffmpeg command as a string.
     * @example
     * console.log(proc.toString());
     */
    toString(): string;
    private setupAbortSignal;
    private setupTimeout;
    private setupInputStreams;
    private setupOutputStreams;
    private setupProcessEvents;
    private handleStderrData;
    private handleProcessExit;
    private createExitError;
    private finish;
    private cleanup;
    private parseProgress;
}
export default Processor;
