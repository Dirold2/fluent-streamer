"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Processor = void 0;
const eventemitter3_1 = require("eventemitter3");
const stream_1 = require("stream");
const execa_1 = require("execa");
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
class Processor extends eventemitter3_1.EventEmitter {
    process = null;
    outputStream = null;
    inputStreams = [];
    stderrBuffer = "";
    isTerminating = false;
    hasFinished = false;
    timeoutHandle;
    doneResolve;
    doneReject;
    donePromise;
    config;
    pid = null;
    args = [];
    constructor(options = {}) {
        super();
        this.config = {
            ffmpegPath: options.ffmpegPath ?? "ffmpeg",
            failFast: options.failFast ?? false,
            extraGlobalArgs: options.extraGlobalArgs ?? [],
            loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
            timeout: options.timeout ?? 0,
            maxStderrBuffer: options.maxStderrBuffer ?? 1024 * 1024,
            enableProgressTracking: options.enableProgressTracking ?? false,
            logger: options.logger ?? console,
            suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
            abortSignal: options.abortSignal,
            headers: options.headers ?? {},
        };
        this.donePromise = new Promise((resolve, reject) => {
            this.doneResolve = resolve;
            this.doneReject = reject;
        });
        this.setupAbortSignal();
    }
    /**
     * Set the command-line arguments for FFmpeg.
     * @param args The ffmpeg argument array (excluding executable).
     * @returns this
     * @example
     * proc.setArgs(["-i", "pipe:0", "-f", "mp3", "pipe:1"]);
     */
    setArgs(args) {
        this.args = [...args];
        return this;
    }
    /**
     * Get a copy of the FFmpeg arguments for this Processor.
     */
    getArgs() {
        return [...this.args];
    }
    /**
     * Set the process input streams.
     * @param streams An array of objects with .stream (Readable) and .index
     * @returns this
     * @example
     * proc.setInputStreams([{ stream: myInput, index: 0 }]);
     */
    setInputStreams(streams) {
        this.inputStreams = streams;
        return this;
    }
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
    run() {
        if (this.process) {
            throw new Error("FFmpeg process is already running");
        }
        this.outputStream = new stream_1.PassThrough();
        const fullCmd = `${this.config.ffmpegPath} ${this.args.join(" ")}`;
        this.emit("start", fullCmd);
        this.config.logger.debug?.(`[${this.config.loggerTag}] Starting: ${fullCmd}`);
        this.process = (0, execa_1.execa)(this.config.ffmpegPath, this.args, {
            reject: false,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.pid = this.process.pid ?? null;
        this.config.logger.debug?.(`[${this.config.loggerTag}] PID: ${this.pid}`);
        this.setupTimeout();
        this.setupInputStreams();
        this.setupOutputStreams();
        this.setupProcessEvents();
        this.process.once("spawn", () => {
            this.emit("spawn", { pid: this.process?.pid ?? null });
        });
        return {
            output: this.outputStream,
            done: this.donePromise,
            stop: () => this.kill(),
        };
    }
    /**
     * Send a signal to terminate the FFmpeg process.
     * @param signal The signal to send (default SIGTERM)
     * @example
     * proc.kill(); // send SIGTERM
     * proc.kill("SIGKILL");
     */
    kill(signal = "SIGTERM") {
        if (this.process && !this.isTerminating) {
            this.isTerminating = true;
            this.config.logger.debug?.(`[${this.config.loggerTag}] Killing process with signal ${signal}`);
            this.process.kill(signal);
        }
    }
    /**
     * Get a string representation of the full ffmpeg command.
     * @returns The ffmpeg command as a string.
     * @example
     * console.log(proc.toString());
     */
    toString() {
        return `${this.config.ffmpegPath} ${this.getArgs().join(" ")}`;
    }
    setupAbortSignal() {
        const { abortSignal } = this.config;
        if (!abortSignal)
            return;
        const onAbort = () => this.kill("SIGTERM");
        if (abortSignal.aborted) {
            onAbort();
        }
        else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
        }
    }
    setupTimeout() {
        if (this.config.timeout > 0) {
            this.timeoutHandle = setTimeout(() => {
                this.config.logger.warn?.(`[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`);
                this.kill("SIGKILL");
            }, this.config.timeout);
        }
    }
    setupInputStreams() {
        if (this.inputStreams.length === 0 || !this.process?.stdin) {
            return;
        }
        const inputStream = this.inputStreams[0].stream;
        (0, stream_1.pipeline)(inputStream, this.process.stdin, (err) => {
            if (err) {
                if (err.code === "EPIPE" && (this.hasFinished || this.isTerminating)) {
                    return;
                }
                this.config.logger.error?.(`[${this.config.loggerTag}] Input pipeline failed: ${err.message}`);
                this.emit("error", err);
                this.finish(err);
            }
        });
    }
    setupOutputStreams() {
        if (!this.process || !this.outputStream) {
            return;
        }
        if (this.process.stdout) {
            (0, stream_1.pipeline)(this.process.stdout, this.outputStream, (err) => {
                if (err) {
                    if (err.message && /premature close/i.test(err.message)) {
                        if (this.hasFinished || this.isTerminating || this.config.suppressPrematureCloseWarning) {
                            return;
                        }
                        this.config.logger.warn?.(`[${this.config.loggerTag}] Output pipeline warning: Premature close`);
                        return;
                    }
                    this.config.logger.error?.(`[${this.config.loggerTag}] Output pipeline failed: ${err.message}`);
                    this.emit("error", err);
                    this.finish(err);
                }
            });
        }
        this.process.stderr?.on("data", (chunk) => this.handleStderrData(chunk));
    }
    setupProcessEvents() {
        this.process?.once("exit", (code, signal) => this.handleProcessExit(code, signal));
        this.process?.once("error", (err) => {
            this.config.logger.error?.(`[${this.config.loggerTag}] Process error: ${err.message}`);
            this.emit("error", err);
            this.finish(err);
        });
    }
    handleStderrData(chunk) {
        const text = chunk.toString("utf-8");
        if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
            this.stderrBuffer += text;
            if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
                this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - this.config.maxStderrBuffer);
            }
        }
        if (this.config.enableProgressTracking) {
            const lines = text.split(/[\r\n]+/);
            for (const line of lines) {
                if (line.includes("=")) {
                    const progress = this.parseProgress(line);
                    if (progress)
                        this.emit("progress", progress);
                }
            }
        }
    }
    handleProcessExit(code, signal) {
        if (this.hasFinished)
            return;
        this.config.logger.debug?.(`[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`);
        const isSuccess = code === 0 || (signal !== null && this.isTerminating);
        if (isSuccess) {
            if (this.isTerminating) {
                this.emit("terminated", signal ?? "SIGTERM");
            }
            this.emit("end");
            this.finish();
        }
        else {
            const error = this.createExitError(code, signal);
            this.emit("error", error);
            this.finish(error);
        }
    }
    createExitError(code, signal) {
        const stderrSnippet = this.stderrBuffer.trim().slice(-1000);
        let message = `FFmpeg exited with code ${code}`;
        if (signal)
            message += ` (signal ${signal})`;
        if (stderrSnippet) {
            message += `.\nLast stderr output:\n${stderrSnippet}`;
        }
        return new Error(message);
    }
    finish(error) {
        if (this.hasFinished)
            return;
        this.hasFinished = true;
        if (this.timeoutHandle)
            clearTimeout(this.timeoutHandle);
        this.cleanup();
        if (error) {
            this.doneReject(error);
        }
        else {
            this.doneResolve();
        }
    }
    cleanup() {
        this.process?.stdout?.destroy();
        this.process?.stderr?.destroy();
        this.outputStream?.destroy();
    }
    parseProgress(line) {
        const progress = {};
        const pairs = line.trim().split(/\s+/);
        for (const pair of pairs) {
            const [key, value] = pair.split('=', 2);
            if (!key || !value)
                continue;
            switch (key) {
                case "frame":
                    progress.frame = parseInt(value, 10);
                    break;
                case "fps":
                    progress.fps = parseFloat(value);
                    break;
                case "bitrate":
                    progress.bitrate = value;
                    break;
                case "total_size":
                    progress.totalSize = parseInt(value, 10);
                    break;
                case "out_time_us":
                    progress.outTimeUs = parseInt(value, 10);
                    break;
                case "out_time":
                    progress.outTime = value;
                    break;
                case "dup_frames":
                    progress.dupFrames = parseInt(value, 10);
                    break;
                case "drop_frames":
                    progress.dropFrames = parseInt(value, 10);
                    break;
                case "speed":
                    progress.speed = parseFloat(value.replace("x", ""));
                    break;
                case "progress":
                    progress.progress = value;
                    break;
            }
        }
        return Object.keys(progress).length > 0 ? progress : null;
    }
}
exports.Processor = Processor;
exports.default = Processor;
//# sourceMappingURL=Processor.js.map