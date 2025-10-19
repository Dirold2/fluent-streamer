import { EventEmitter } from "eventemitter3";
import { Readable, Writable } from "stream";
import type { FFmpegRunResult } from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";
/**
 * Processor launches FFmpeg processes and manages their IO streams,
 * progress tracking, timeouts, and lifecycle events for robust orchestration.
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
    get pid(): number | null;
    constructor(options?: ProcessorOptions);
    setArgs(args: string[]): this;
    getArgs(): string[];
    setInputStreams(streams: Array<{
        stream: Readable;
        index: number;
    }>): this;
    getInputStream(): NodeJS.WritableStream | undefined;
    setExtraOutputStreams(streams: Array<{
        stream: Writable;
        index: number;
    }>): this;
    setExtraGlobalArgs(args: string[]): this;
    getFullArgs(): string[];
    /**
     * Runs the ffmpeg process according to current arguments and options.
     * Returns handles to output stream, a promise for completion, and stop function.
     */
    run(): FFmpegRunResult;
    kill(signal?: NodeJS.Signals): void;
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
    private _parseProgress;
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
