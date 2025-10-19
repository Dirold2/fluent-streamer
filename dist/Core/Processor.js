"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Processor = void 0;
const eventemitter3_1 = require("eventemitter3");
const stream_1 = require("stream");
const execa_1 = require("execa");
/**
 * Processor launches FFmpeg processes and manages their IO streams,
 * progress tracking, timeouts, and lifecycle events for robust orchestration.
 */
class Processor extends eventemitter3_1.EventEmitter {
    process = null;
    outputStream = null;
    inputStreams = [];
    extraOutputs = [];
    stderrBuffer = "";
    isTerminating = false;
    hasFinished = false;
    timeoutHandle;
    progress = {};
    doneResolve;
    doneReject;
    donePromise;
    config;
    args = [];
    extraGlobalArgs = [];
    get pid() {
        return this.process?.pid ?? null;
    }
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
        this.extraGlobalArgs = this.config.extraGlobalArgs;
        this.donePromise = new Promise((resolve, reject) => {
            this.doneResolve = resolve;
            this.doneReject = reject;
        });
        this._handleAbortSignal();
    }
    setArgs(args) {
        this.args = [...args];
        return this;
    }
    getArgs() {
        return [...this.args];
    }
    setInputStreams(streams) {
        this.inputStreams = streams;
        return this;
    }
    getInputStream() {
        return this.process?.stdin || undefined;
    }
    setExtraOutputStreams(streams) {
        this.extraOutputs = streams;
        return this;
    }
    setExtraGlobalArgs(args) {
        this.extraGlobalArgs = [...args];
        return this;
    }
    getFullArgs() {
        return [...this.extraGlobalArgs, ...this.args];
    }
    /**
     * Runs the ffmpeg process according to current arguments and options.
     * Returns handles to output stream, a promise for completion, and stop function.
     */
    run() {
        if (this.process)
            throw new Error("FFmpeg process is already running");
        this.outputStream = new stream_1.PassThrough();
        const fullArgs = this.getFullArgs();
        const fullCmd = `${this.config.ffmpegPath} ${fullArgs.join(" ")}`;
        this.emit("start", fullCmd);
        this.config.logger.debug?.(`[${this.config.loggerTag}] Starting: ${fullCmd}`);
        this.process = (0, execa_1.execa)(this.config.ffmpegPath, fullArgs, {
            reject: false,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.config.logger.debug?.(`[${this.config.loggerTag}] PID: ${this.process.pid ?? null}`);
        this._handleTimeout();
        this._bindInputStream();
        this._bindOutputStreams();
        this._bindProcessEvents();
        this.process.once("spawn", () => {
            this.emit("spawn", { pid: this.process?.pid ?? null });
        });
        return {
            output: this.outputStream,
            done: this.donePromise,
            stop: () => this.kill(),
        };
    }
    kill(signal = "SIGTERM") {
        if (this.process && !this.isTerminating) {
            this.isTerminating = true;
            this.config.logger.debug?.(`[${this.config.loggerTag}] Killing process with signal ${signal}`);
            this.process.kill(signal);
        }
    }
    static buildAcrossfadeFilter(opts = {}) {
        let str = "acrossfade";
        let hasParam = false;
        const add = (key, val) => {
            if (val === undefined || val === "")
                return;
            str += (hasParam ? ":" : "=") + key + "=" + val;
            hasParam = true;
        };
        add("d", opts.duration);
        add("c1", opts.curve1 ?? "tri");
        add("c2", opts.curve2 ?? "tri");
        add("ns", opts.nb_samples);
        if (opts.overlap === false)
            add("o", 0);
        if (opts.inputs && opts.inputs !== 2)
            add("n", opts.inputs);
        if (opts.outputLabel && opts.outputLabel.length) {
            str += `[${opts.outputLabel}]`;
            return { filter: str, outputLabel: opts.outputLabel };
        }
        return { filter: str };
    }
    toString() {
        return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
    }
    _handleAbortSignal() {
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
    _handleTimeout() {
        if (this.config.timeout > 0) {
            this.timeoutHandle = setTimeout(() => {
                this.config.logger.warn?.(`[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`);
                this.kill("SIGKILL");
            }, this.config.timeout);
        }
    }
    _bindInputStream() {
        if (!this.inputStreams.length || !this.process?.stdin)
            return;
        const { stream: inputStream } = this.inputStreams.find((i) => i.index === 0) || this.inputStreams[0];
        (0, stream_1.pipeline)(inputStream, this.process.stdin, (err) => {
            if (err) {
                if (err.code === "EPIPE" && (this.hasFinished || this.isTerminating)) {
                    return;
                }
                this.config.logger.error?.(`[${this.config.loggerTag}] Input pipeline failed: ${err.message}`);
                this.emit("error", err);
                this._finalize(err);
            }
        });
    }
    _bindOutputStreams() {
        if (!this.process || !this.outputStream)
            return;
        if (this.process.stdout) {
            (0, stream_1.pipeline)(this.process.stdout, this.outputStream, (err) => {
                if (err) {
                    if (err.message &&
                        /premature close/i.test(err.message) &&
                        (this.hasFinished ||
                            this.isTerminating ||
                            this.config.suppressPrematureCloseWarning)) {
                        return;
                    }
                    if (err.message && /premature close/i.test(err.message)) {
                        this.config.logger.warn?.(`[${this.config.loggerTag}] Output pipeline warning: Premature close`);
                        return;
                    }
                    this.config.logger.error?.(`[${this.config.loggerTag}] Output pipeline failed: ${err.message}`);
                    this.emit("error", err);
                    this._finalize(err);
                }
            });
        }
        // Placeholder for extra outputs (pipe:2, etc.)
        for (const {} of this.extraOutputs) {
        }
        this.process.stderr?.on("data", (chunk) => this._handleStderr(chunk));
    }
    _bindProcessEvents() {
        this.process?.once("exit", (code, signal) => this._onProcessExit(code, signal));
        this.process?.once("error", (err) => {
            this.config.logger.error?.(`[${this.config.loggerTag}] Process error: ${err.message}`);
            this.emit("error", err);
            this._finalize(err);
        });
        this.process?.on("close", (code, signal) => {
            this.config.logger.debug?.(`[${this.config.loggerTag}] close event: code=${code} signal=${signal}`);
        });
    }
    _handleStderr(chunk) {
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
                if (line && line.includes("=")) {
                    const progress = this._parseProgress(line);
                    if (progress) {
                        this.progress = { ...this.progress, ...progress };
                        this.emit("progress", { ...this.progress });
                    }
                }
            }
        }
    }
    _onProcessExit(code, signal) {
        if (this.hasFinished)
            return;
        this.config.logger.debug?.(`[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`);
        // Accept code==0 as success, but also accept code==1 if STDOUT was empty (ffmpeg -i returns 1 for not enough input sometimes).
        // The sample log shows close event with code=1, signal=null but didn't crash/output error.
        // For robustness, treat code==1 and non-term signals as an error,
        // but still optionally provide extended diagnostics.
        if (code === 0 || (signal !== null && this.isTerminating)) {
            if (this.isTerminating) {
                this.emit("terminated", signal ?? "SIGTERM");
            }
            this.emit("end");
            this._finalize();
        }
        else {
            const error = this._getProcessExitError(code, signal);
            this.emit("error", error);
            this._finalize(error);
        }
    }
    _getProcessExitError(code, signal) {
        const stderrSnippet = this.stderrBuffer.trim().slice(-1000);
        let message = `FFmpeg exited with code ${code}`;
        if (signal)
            message += ` (signal ${signal})`;
        if (stderrSnippet) {
            message += `.\nLast stderr output:\n${stderrSnippet}`;
        }
        return new Error(message);
    }
    _finalize(error) {
        if (this.hasFinished)
            return;
        this.hasFinished = true;
        if (this.timeoutHandle)
            clearTimeout(this.timeoutHandle);
        this._cleanup();
        if (error) {
            this.doneReject(error);
        }
        else {
            this.doneResolve();
        }
    }
    _cleanup() {
        this.process?.stdout?.destroy();
        this.process?.stderr?.destroy();
        this.outputStream?.destroy();
        for (const { stream } of this.extraOutputs) {
            stream.destroy();
        }
    }
    _parseProgress(line) {
        const progress = {};
        const pairs = line.trim().split(/\s+/);
        for (const pair of pairs) {
            const [key, value] = pair.split("=", 2);
            if (!key || value == null)
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
                case "size":
                    progress.size = value;
                    break;
                case "time":
                    progress.time = value;
                    break;
                case "packet":
                    progress.packet = parseInt(value, 10);
                    break;
                case "chapter":
                    progress.chapter = parseInt(value, 10);
                    break;
            }
        }
        return Object.keys(progress).length > 0 ? progress : null;
    }
    static create(params) {
        if (!params)
            return new Processor();
        const { args, inputStreams, options, ...rest } = params;
        const workerOptions = {
            ...(typeof options === "object" ? options : {}),
            ...rest,
        };
        const worker = new Processor(workerOptions);
        if (Array.isArray(args))
            worker.setArgs(args);
        if (Array.isArray(inputStreams))
            worker.inputStreams = [...inputStreams];
        return worker;
    }
}
exports.Processor = Processor;
exports.default = Processor;
//# sourceMappingURL=Processor.js.map