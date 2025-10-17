/**
 * Low-level FFmpeg process runner.
 *
 * This class is responsible for spawning the FFmpeg process, wiring stdin/stdout/stderr,
 * handling timeouts and termination, and emitting lifecycle/progress events.
 * It does not implement a fluent API and does not depend on the fluent wrapper.
 */
import { EventEmitter } from "eventemitter3";
import { type Readable } from "stream";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "src/Types";
/**
 * Options for the low-level Processor. Inherits common FFmpeg options.
 */
export interface ProcessorOptions extends SimpleFFmpegOptions {
}
/**
 * Executes FFmpeg with provided arguments and optional input stream(s).
 *
 * Events:
 * - start: (cmd: string) emitted right before process spawn with full command string
 * - progress: (progress: Record<string, unknown>) parsed -progress key/value updates
 * - end: () emitted on successful completion (or recoverable termination)
 * - terminated: (signal: string) emitted if finished due to termination or recoverable exit
 * - error: (error: Error) emitted on process/pipeline errors or non-zero fatal exit
 */
export declare class Processor extends EventEmitter {
    private process;
    private outputStream;
    private inputStreams;
    private stderrBuffer;
    private isTerminating;
    private finished;
    private timeoutHandle?;
    private doneResolve;
    private doneReject;
    private readonly donePromise;
    private readonly config;
    readonly pid: number | null;
    private args;
    /**
     * Create a new Processor.
     * @param options - process-level configuration and logging
     */
    constructor(options?: ProcessorOptions);
    /**
     * Replace the full argument list passed to FFmpeg (excluding the binary path).
     * @param args - array of arguments (e.g. ["-i", "in.mp4", "-f", "mp4", "pipe:1"])
     */
    setArgs(args: string[]): this;
    /**
     * Set input streams to be piped to FFmpeg stdin (first stream supported).
     * @param streams - list of readable streams and their indices
     */
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    /**
     * Spawn the FFmpeg process and connect streams.
     * @returns output PassThrough stream and completion promise
     * @throws if called more than once per instance
     */
    run(): FFmpegRunResult;
    /**
     * Request process termination.
     * @param signal - signal to send (default: SIGTERM)
     */
    kill(signal?: NodeJS.Signals): void;
    /** Get full command as a string. */
    toString(): string;
    /** Get a copy of current args. */
    getArgs(): string[];
    /** Promise resolved/rejected on process completion. */
    get done(): Promise<void>;
    /** Access underlying stdout (available after run()). */
    get stdout(): Readable;
    private setupAbortSignal;
    private applyInitialArgs;
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
    private isIgnorableError;
}
export default Processor;
