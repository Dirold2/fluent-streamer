"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Processor = void 0;
/**
 * Low-level FFmpeg process runner.
 *
 * This class is responsible for spawning the FFmpeg process, wiring stdin/stdout/stderr,
 * handling timeouts and termination, and emitting lifecycle/progress events.
 * It does not implement a fluent API and does not depend on the fluent wrapper.
 */
const eventemitter3_1 = require("eventemitter3");
const stream_1 = require("stream");
const execa_1 = require("execa");
const TERMINATION_ERROR_PATTERNS = [
    "sigkill",
    "sigterm",
    "was killed",
    "premature close",
    "err_stream_premature_close",
    "other side closed",
    "econnreset",
    "socketerror",
    "timeout",
    "request aborted",
    "aborted",
    "write after end",
    "epipe",
];
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
class Processor extends eventemitter3_1.EventEmitter {
    process = null;
    outputStream = null;
    inputStreams = [];
    stderrBuffer = "";
    isTerminating = false;
    finished = false;
    timeoutHandle;
    doneResolve;
    doneReject;
    donePromise;
    config;
    pid = null;
    args = [];
    /**
     * Create a new Processor.
     * @param options - process-level configuration and logging
     */
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
            abortSignal: options.abortSignal,
        };
        this.donePromise = new Promise((resolve, reject) => {
            this.doneResolve = resolve;
            this.doneReject = reject;
        });
        this.setupAbortSignal();
        this.applyInitialArgs();
    }
    /**
     * Replace the full argument list passed to FFmpeg (excluding the binary path).
     * @param args - array of arguments (e.g. ["-i", "in.mp4", "-f", "mp4", "pipe:1"])
     */
    setArgs(args) {
        this.args = [...args];
        return this;
    }
    /**
     * Set input streams to be piped to FFmpeg stdin (first stream supported).
     * @param streams - list of readable streams and their indices
     */
    setInputStreams(streams) {
        this.inputStreams = streams;
        return this;
    }
    /**
     * Spawn the FFmpeg process and connect streams.
     * @returns output PassThrough stream and completion promise
     * @throws if called more than once per instance
     */
    run() {
        if (this.process)
            throw new Error("FFmpeg process is already running");
        this.outputStream = new stream_1.PassThrough();
        const fullCmd = `${this.config.ffmpegPath} ${this.args.join(" ")}`;
        this.emit("start", fullCmd);
        this.config.logger.debug?.(`Starting: ${fullCmd}`);
        this.process = (0, execa_1.execa)(this.config.ffmpegPath, this.args, {
            reject: false,
            all: false,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.pid = this.process.pid ?? null;
        this.config.logger.debug?.(`PID: ${this.pid}`);
        this.setupTimeout();
        this.setupInputStreams();
        this.setupOutputStreams();
        this.setupProcessEvents();
        // Re-emit spawn so callers can reliably get PID
        this.process.once("spawn", () => {
            this.emit("spawn", { pid: this.process?.pid ?? null });
        });
        return { output: this.outputStream, done: this.donePromise };
    }
    /**
     * Request process termination.
     * @param signal - signal to send (default: SIGTERM)
     */
    kill(signal = "SIGTERM") {
        if (this.process && !this.isTerminating) {
            this.isTerminating = true;
            try {
                this.cleanup();
                this.process.kill(signal);
            }
            catch (error) {
                this.config.logger.debug?.(`Kill error (ignored): ${error}`);
            }
        }
    }
    /** Get full command as a string. */
    toString() {
        return `${this.config.ffmpegPath} ${this.args.join(" ")}`;
    }
    /** Get a copy of current args. */
    getArgs() {
        return [...this.args];
    }
    /** Promise resolved/rejected on process completion. */
    get done() {
        return this.donePromise;
    }
    /** Access underlying stdout (available after run()). */
    get stdout() {
        if (!this.process?.stdout)
            throw new Error("FFmpeg process not started or stdout unavailable");
        return this.process.stdout;
    }
    // ====================== Private ======================
    setupAbortSignal() {
        if (!this.config.abortSignal)
            return;
        if (this.config.abortSignal.aborted) {
            this.kill("SIGTERM");
        }
        else {
            this.config.abortSignal.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
        }
    }
    applyInitialArgs() {
        if (this.config.extraGlobalArgs.length > 0)
            this.args.push(...this.config.extraGlobalArgs);
        if (this.config.failFast)
            this.args.push("-xerror");
        if (this.config.enableProgressTracking)
            this.args.push("-progress", "pipe:2");
    }
    setupTimeout() {
        if (this.config.timeout && this.config.timeout > 0) {
            this.timeoutHandle = setTimeout(() => {
                this.config.logger.warn?.(`Process timeout after ${this.config.timeout}ms`);
                this.kill("SIGTERM");
            }, this.config.timeout);
        }
    }
    setupInputStreams() {
        if (this.inputStreams.length === 0 || !this.process?.stdin)
            return;
        const first = this.inputStreams[0];
        const endStdin = () => {
            if (this.process?.stdin && !this.process.stdin.destroyed)
                this.process.stdin.end();
        };
        first.stream.once("end", endStdin).once("close", endStdin);
        first.stream.on("error", (err) => {
            if (!this.isIgnorableError(err)) {
                this.config.logger.error?.(`Input stream error: ${err.message}`);
                this.emit("error", err);
            }
        });
        this.process.stdin.on("error", (err) => {
            if (!this.isIgnorableError(err)) {
                this.config.logger.error?.(`Stdin error: ${err.message}`);
                this.emit("error", err);
            }
        });
        (0, stream_1.pipeline)(first.stream, this.process.stdin, (err) => {
            if (err && !this.isIgnorableError(err)) {
                this.config.logger.error?.(`Pipeline failed: ${err.message}`);
                this.emit("error", err);
            }
        });
    }
    setupOutputStreams() {
        if (!this.process || !this.outputStream)
            return;
        this.process.stdout?.on("error", (e) => this.config.logger.debug?.(`stdout error: ${e}`));
        this.process.stderr?.on("error", (e) => this.config.logger.debug?.(`stderr error: ${e}`));
        if (this.process.stdout) {
            (0, stream_1.pipeline)(this.process.stdout, this.outputStream, (err) => {
                if (err && !this.isIgnorableError(err)) {
                    this.config.logger.error?.(`Output pipeline failed: ${err.message}`);
                    this.emit("error", err);
                }
            });
        }
        this.process.stderr?.on("data", (chunk) => this.handleStderrData(chunk));
    }
    setupProcessEvents() {
        if (!this.process)
            return;
        this.process.once("exit", (code, signal) => this.handleProcessExit(code, signal));
        this.process.once("error", (err) => {
            if (!this.isTerminating || !this.isIgnorableError(err)) {
                this.config.logger.error?.(`Process error: ${err.message}`);
                this.emit("error", err);
                this.finish(err);
            }
        });
        this.process.on("cancel", () => this.kill("SIGTERM"));
    }
    handleStderrData(chunk) {
        const text = chunk.toString("utf-8");
        if (this.stderrBuffer.length + text.length > this.config.maxStderrBuffer) {
            this.stderrBuffer = this.stderrBuffer.slice(text.length);
        }
        this.stderrBuffer += text;
        if (this.config.enableProgressTracking) {
            const lines = text.split("\n");
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
        this.cleanup();
        const isRecoverableExit = code === 152 || code === 183 || code === 255;
        const isSuccess = (code === 0 && !this.isTerminating) ||
            this.isTerminating ||
            isRecoverableExit;
        if (isSuccess) {
            if (this.isTerminating || isRecoverableExit)
                this.emit("terminated", signal ?? "SIGTERM");
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
        const stderrSnippet = this.stderrBuffer.trim().slice(0, 2000);
        let message = `FFmpeg exited with code ${code}`;
        if (signal)
            message += `, signal ${signal}`;
        if (stderrSnippet)
            message += `, stderr: ${stderrSnippet.replace(/\n/g, " ")}`;
        return new Error(message);
    }
    finish(error) {
        if (this.finished)
            return;
        this.finished = true;
        if (this.timeoutHandle)
            clearTimeout(this.timeoutHandle);
        if (error)
            this.doneReject(error);
        else
            this.doneResolve();
    }
    cleanup() {
        try {
            this.outputStream?.destroy();
            this.process?.stdin?.end();
            this.process?.stdout?.destroy();
            this.process?.stderr?.destroy();
        }
        catch (error) {
            this.config.logger.debug?.(`Cleanup error (ignored): ${error}`);
        }
    }
    parseProgress(line) {
        const progress = {};
        const parts = line.split("=");
        for (let i = 0; i < parts.length - 1; i += 2) {
            const key = parts[i].trim();
            const value = parts[i + 1].trim();
            switch (key) {
                case "frame":
                    progress.frame = Number.parseInt(value, 10);
                    break;
                case "fps":
                    progress.fps = Number.parseFloat(value);
                    break;
                case "bitrate":
                    progress.bitrate = value;
                    break;
                case "total_size":
                    progress.totalSize = Number.parseInt(value, 10);
                    break;
                case "out_time_us":
                    progress.outTimeUs = Number.parseInt(value, 10);
                    break;
                case "out_time":
                    progress.outTime = value;
                    break;
                case "dup_frames":
                    progress.dupFrames = Number.parseInt(value, 10);
                    break;
                case "drop_frames":
                    progress.dropFrames = Number.parseInt(value, 10);
                    break;
                case "speed":
                    progress.speed = Number.parseFloat(value.replace("x", ""));
                    break;
                case "progress":
                    progress.progress = value;
                    break;
                default:
                    break;
            }
        }
        return Object.keys(progress).length > 0 ? progress : null;
    }
    isIgnorableError(error) {
        const message = (error?.message || "").toLowerCase();
        return (error?.code === "EPIPE" ||
            TERMINATION_ERROR_PATTERNS.some((p) => message.includes(p)));
    }
}
exports.Processor = Processor;
exports.default = Processor;
//# sourceMappingURL=Processor.js.map