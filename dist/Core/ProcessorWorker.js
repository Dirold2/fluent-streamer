"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setExtraOutputStream = setExtraOutputStream;
const worker_threads_1 = require("worker_threads");
const child_process_1 = require("child_process");
const stream_1 = require("stream");
const extraOutputStreams = new Map();
let ffmpegProcess = null;
let extraOutputIndexes = [];
/**
 * Simple debug log with process tag.
 *
 * When FF_DEBUG env is enabled, log messages with process tag.
 *
 * @param prefix
 * @param args
 * @example
 * logDebug('start', 'args', 123)
 */
function logDebug(prefix, ...args) {
    if (!process.env.FF_DEBUG)
        return;
    const tag = ffmpegProcess?.pid != null
        ? "[ffmpeg_" + ffmpegProcess.pid + "]"
        : "[ffmpeg_worker]";
    // eslint-disable-next-line no-console
    console.log(tag, prefix, ...args);
}
/**
 * Connect ffmpeg output streams to PassThrough and parentPort.
 *
 * Sets up listeners for stdout and any extra output pipes.
 *
 * @param proc ChildProcess instance from spawn
 * @example
 * setupOutputStreams(childProc)
 */
function setupOutputStreams(proc) {
    if (proc.stdout) {
        proc.stdout.on("data", (chunk) => {
            worker_threads_1.parentPort?.postMessage({ type: "stdout", data: chunk });
            const pass = extraOutputStreams.get(1);
            if (pass)
                pass.write(chunk);
        });
    }
    for (let i = 0; i < extraOutputIndexes.length; ++i) {
        const pipeNum = extraOutputIndexes[i];
        const fd = 3 + i;
        const stream = proc.stdio[fd];
        if (!stream)
            continue;
        let pass = extraOutputStreams.get(pipeNum);
        if (!pass) {
            pass = new stream_1.PassThrough();
            extraOutputStreams.set(pipeNum, pass);
        }
        stream.on("data", (chunk) => {
            worker_threads_1.parentPort?.postMessage({ type: "stdout", pipe: pipeNum, data: chunk });
            pass.write(chunk);
        });
        stream.on("end", () => pass.end());
        stream.on("error", (err) => pass.destroy(err));
    }
}
/**
 * Register or update extra PassThrough for a given ffmpeg pipeNum.
 *
 * @param pipeNum number
 * @param stream PassThrough
 * @example
 * setExtraOutputStream(4, new PassThrough())
 */
function setExtraOutputStream(pipeNum, stream) {
    extraOutputStreams.set(pipeNum, stream);
}
worker_threads_1.parentPort?.on("message", (msg) => {
    try {
        switch (msg.type) {
            case "start": {
                if (!msg.args)
                    return;
                if (ffmpegProcess) {
                    worker_threads_1.parentPort?.postMessage({
                        type: "error",
                        error: "Process already running",
                    });
                    return;
                }
                const options = msg.options ?? {};
                const extraPipes = [];
                extraOutputIndexes = [];
                const arr = msg.args;
                for (let i = 2; i < 16; ++i) {
                    if (arr.indexOf("pipe:" + i) !== -1) {
                        extraPipes.push("pipe");
                        extraOutputIndexes.push(i);
                    }
                }
                const stdio = ["pipe", "pipe", "pipe"];
                if (extraPipes.length)
                    stdio.push(...extraPipes);
                logDebug("Starting:", options.ffmpegPath ?? "ffmpeg", ...msg.args);
                ffmpegProcess = (0, child_process_1.spawn)(options.ffmpegPath ?? "ffmpeg", msg.args, {
                    stdio: stdio,
                });
                logDebug("PID:", ffmpegProcess.pid);
                setupOutputStreams(ffmpegProcess);
                if (ffmpegProcess.stderr) {
                    let progressBuffer = "";
                    ffmpegProcess.stderr.on("data", (chunk) => {
                        worker_threads_1.parentPort?.postMessage({ type: "stderr", data: chunk });
                        progressBuffer += chunk.toString();
                        let idx;
                        while ((idx = progressBuffer.indexOf("\n")) >= 0) {
                            const line = progressBuffer.slice(0, idx).trim();
                            progressBuffer = progressBuffer.slice(idx + 1);
                            if (line && line.indexOf("=") !== -1) {
                                const progress = parseProgress(line);
                                if (progress)
                                    worker_threads_1.parentPort?.postMessage({ type: "progress", progress });
                            }
                        }
                        if (progressBuffer.length > 2000) {
                            progressBuffer = progressBuffer.slice(-1000);
                        }
                    });
                }
                ffmpegProcess.once("exit", (code, signal) => {
                    logDebug("Process exited with code", code, "signal", signal);
                    worker_threads_1.parentPort?.postMessage({ type: "end", code, signal });
                    ffmpegProcess = null;
                    extraOutputStreams.forEach((pt) => pt.end());
                    extraOutputStreams.clear();
                });
                ffmpegProcess.once("close", (code, signal) => {
                    logDebug("close event:", { code, signal });
                });
                ffmpegProcess.once("error", (err) => {
                    worker_threads_1.parentPort?.postMessage({
                        type: "error",
                        error: err.message,
                    });
                    ffmpegProcess = null;
                    extraOutputStreams.forEach((pt) => pt.destroy(err));
                    extraOutputStreams.clear();
                });
                break;
            }
            case "stop":
            case "abortSignal":
                if (ffmpegProcess && ffmpegProcess.kill) {
                    ffmpegProcess.kill("SIGTERM");
                }
                break;
            case "kill":
                if (ffmpegProcess && ffmpegProcess.kill) {
                    ffmpegProcess.kill(msg.signal ?? "SIGKILL");
                }
                break;
            case "signal":
                if (ffmpegProcess && ffmpegProcess.kill && msg.signal) {
                    ffmpegProcess.kill(msg.signal);
                }
                break;
            case "input":
                if (ffmpegProcess?.stdin && msg.inputData) {
                    const res = ffmpegProcess.stdin.write(msg.inputData);
                    if (!res) {
                        ffmpegProcess.stdin.once("drain", () => {
                            worker_threads_1.parentPort?.postMessage({ type: "stdin-drain" });
                        });
                    }
                }
                break;
            case "status":
                worker_threads_1.parentPort?.postMessage({
                    type: "status",
                    running: !!ffmpegProcess,
                    pid: ffmpegProcess?.pid ?? null,
                });
                break;
            case "getExtraOutput":
                if (typeof msg.pipeNum === "number") {
                    let pt = extraOutputStreams.get(msg.pipeNum);
                    if (!pt) {
                        pt = new stream_1.PassThrough();
                        extraOutputStreams.set(msg.pipeNum, pt);
                    }
                    worker_threads_1.parentPort?.postMessage({
                        type: "ack-getExtraOutput",
                        pipe: msg.pipeNum,
                    });
                }
                break;
        }
    }
    catch (err) {
        logDebug("Worker error:", err?.stack || err);
        worker_threads_1.parentPort?.postMessage({
            type: "error",
            error: err?.message || String(err),
        });
    }
});
/**
 * Parse key-value line from ffmpeg progress output.
 * Returns Partial<FFmpegProgress> for known keys, all values as fields.
 *
 * @param line Progress line from ffmpeg (format e.g. "frame=42 fps=28 ...").
 * @returns Partial<FFmpegProgress>|null
 *
 * @example
 * const p = parseProgress("frame=42 fps=30 bitrate=1.5M")
 */
function parseProgress(line) {
    const p = {};
    const a = line.trim().split(/\s+/);
    for (let i = 0; i < a.length; ++i) {
        const s = a[i];
        const eq = s.indexOf("=");
        if (eq <= 0)
            continue;
        const key = s.slice(0, eq);
        const value = s.slice(eq + 1);
        if (!key || value === undefined)
            continue;
        switch (key) {
            case "frame":
                p.frame = +value;
                break;
            case "fps":
                p.fps = +value;
                break;
            case "bitrate":
                p.bitrate = value;
                break;
            case "total_size":
                p.totalSize = +value;
                break;
            case "out_time_us":
                p.outTimeUs = +value;
                break;
            case "out_time":
                p.outTime = value;
                break;
            case "dup_frames":
                p.dupFrames = +value;
                break;
            case "drop_frames":
                p.dropFrames = +value;
                break;
            case "speed":
                p.speed = parseFloat(value.replace("x", ""));
                break;
            case "progress":
                p.progress = value;
                break;
            case "size":
                p.size = value;
                break;
            case "time":
                p.time = value;
                break;
            case "packet":
                p.packet = +value;
                break;
            case "chapter":
                p.chapter = +value;
                break;
            default:
                break;
        }
    }
    return Object.keys(p).length ? p : null;
}
//# sourceMappingURL=ProcessorWorker.js.map