import { parentPort } from "worker_threads";
import { spawn, type ChildProcess } from "child_process";
import { PassThrough } from "stream";
import { type ProcessorOptions, type FFmpegProgress } from "../Types/index.js";

/**
 * Message contract for communication with the worker.
 * Can be extended to support additional outputs and AbortSignal.
 */
interface WorkerMessage {
  type:
    | "start"
    | "stop"
    | "status"
    | "kill"
    | "input"
    | "signal"
    | "abortSignal"
    | "getExtraOutput";
  args?: string[];
  options?: ProcessorOptions;
  signal?: NodeJS.Signals;
  inputData?: Buffer;
  outputs?: number; // How many pipe:N are expected
  pipeNum?: number; // For getExtraOutput
}

/**
 * A map of PassThrough streams for extra pipe outputs (e.g., pipe:2, pipe:3, ...).
 * These are used for integration via MessagePort in the main thread.
 */
const extraOutputStreams = new Map<number, PassThrough>();

let ffmpegProcess: ChildProcess | null = null;
let extraOutputIndexes: number[] = [];

/**
 * Sets up output streams (stdout and extra pipes) for the ffmpeg process.
 * Routes stream data to the parentPort and to registered PassThrough streams.
 *
 * @param ffmpegProcess ChildProcess instance of ffmpeg to setup streams for
 *
 * @private
 */
function _setupOutputStreams(ffmpegProcess: ChildProcess) {
  // Main stdout (pipe:1)
  ffmpegProcess.stdout?.on("data", (chunk) => {
    // Always proxy through parentPort
    parentPort?.postMessage({ type: "stdout", data: chunk });
    // Also send to PassThrough stream if requested (legacy/compat)
    const stream = extraOutputStreams.get(1);
    if (stream) stream.write(chunk);
  });

  // Extra outputs (pipe:2, pipe:3, ...)
  for (let idx = 0; idx < extraOutputIndexes.length; ++idx) {
    const fd = 3 + idx; // fd 3 = pipe:2, fd 4 = pipe:3, ...
    const pipeNum = extraOutputIndexes[idx];
    const stream = ffmpegProcess.stdio[fd] as NodeJS.ReadableStream | undefined;
    if (stream) {
      // Create PassThrough stream if not present
      let pt = extraOutputStreams.get(pipeNum);
      if (!pt) {
        pt = new PassThrough();
        extraOutputStreams.set(pipeNum, pt);
      }
      stream.on("data", (chunk) => {
        // Proxy through parentPort
        parentPort?.postMessage({ type: "stdout", pipe: pipeNum, data: chunk });
        // Write to PassThrough for drop-in stream compatibility
        pt?.write(chunk);
      });
      stream.on("end", () => {
        pt?.end();
      });
      stream.on("error", (err) => {
        pt?.destroy(err as Error);
      });
    }
  }
}

/**
 * Registers a PassThrough stream for a particular pipe output (pipe:2, pipe:3, ...).
 * Allows the main thread to access extra output streams directly from the worker.
 *
 * @param pipeNum The pipe number (e.g., 2 for pipe:2)
 * @param stream The PassThrough stream to associate with the extra output
 *
 * @example
 * // In main thread
 * const { setExtraOutputStream } = require("./ProcessorWorker");
 * const stream = new PassThrough();
 * setExtraOutputStream(2, stream);
 */
function setExtraOutputStream(pipeNum: number, stream: PassThrough) {
  extraOutputStreams.set(pipeNum, stream);
}

parentPort?.on("message", async (msg: WorkerMessage) => {
  switch (msg.type) {
    case "start":
      if (!msg.args) return;
      if (ffmpegProcess) {
        parentPort?.postMessage({
          type: "error",
          error: "Process already running",
        });
        return;
      }
      const options = msg.options ?? {};

      // Detect requested extra pipe outputs ("pipe:2", "pipe:3", etc in args)
      const extraPipes: string[] = [];
      extraOutputIndexes = [];
      for (let i = 2; i < 16; ++i) {
        if (msg.args.includes(`pipe:${i}`)) {
          extraPipes.push("pipe");
          extraOutputIndexes.push(i);
        }
      }

      // stdio: [stdin, stdout, stderr, ...extra pipes]
      const stdio = ["pipe", "pipe", "pipe", ...extraPipes];

      ffmpegProcess = spawn(options.ffmpegPath ?? "ffmpeg", msg.args, {
        stdio: stdio as any,
      });

      _setupOutputStreams(ffmpegProcess);

      // Listen to stderr: logs and progress
      ffmpegProcess.stderr?.on("data", (chunk) => {
        parentPort?.postMessage({ type: "stderr", data: chunk });
        // Parse possible ffmpeg progress lines and emit as progress events
        const lines = chunk.toString().split(/[\r\n]+/);
        for (const line of lines) {
          if (line && line.includes("=")) {
            const progress = parseProgress(line);
            if (progress)
              parentPort?.postMessage({ type: "progress", progress });
          }
        }
      });

      ffmpegProcess.once("exit", (code, signal) => {
        parentPort?.postMessage({ type: "end", code, signal });
        ffmpegProcess = null;
        // Close all PassThrough streams when process ends
        extraOutputStreams.forEach((pt) => pt.end());
        extraOutputStreams.clear();
      });

      ffmpegProcess.once("error", (err) => {
        parentPort?.postMessage({ type: "error", error: err.message });
        ffmpegProcess = null;
        extraOutputStreams.forEach((pt) => pt.destroy(err as Error));
        extraOutputStreams.clear();
      });

      break;

    case "stop":
      ffmpegProcess?.kill("SIGTERM");
      break;

    case "kill":
      if (msg.signal) {
        ffmpegProcess?.kill(msg.signal);
      } else {
        ffmpegProcess?.kill("SIGKILL");
      }
      break;

    case "signal":
      // Allows sending arbitrary kill signals to the process
      if (msg.signal) ffmpegProcess?.kill(msg.signal);
      break;

    case "abortSignal":
      // Listens for abort event from main thread; kills the process gracefully.
      ffmpegProcess?.kill("SIGTERM");
      break;

    case "input":
      // Allows streaming arbitrary Buffer data to ffmpeg's stdin
      if (ffmpegProcess?.stdin && msg.inputData) {
        // Write to stdin; handle backpressure if needed
        const res = ffmpegProcess.stdin.write(msg.inputData);
        if (!res) {
          ffmpegProcess.stdin.once("drain", () => {
            parentPort?.postMessage({ type: "stdin-drain" });
          });
        }
      }
      break;

    case "status":
      parentPort?.postMessage({
        type: "status",
        running: !!ffmpegProcess,
        pid: ffmpegProcess?.pid ?? null,
      });
      break;

    case "getExtraOutput":
      /**
       * Asks the worker to expose/register a PassThrough stream for a given pipe number.
       * Direct stream transfer is not possible via MessagePort – the main thread should
       * fetch the stream by calling setExtraOutputStream.
       *
       * @example
       * parentPort.postMessage({ type: "getExtraOutput", pipeNum: 2 });
       */
      if (typeof msg.pipeNum === "number") {
        let pt = extraOutputStreams.get(msg.pipeNum);
        if (!pt) {
          pt = new PassThrough();
          extraOutputStreams.set(msg.pipeNum, pt);
        }
        // Cannot return the stream directly; send ack
        parentPort?.postMessage({
          type: "ack-getExtraOutput",
          pipe: msg.pipeNum,
        });
      }
      break;
  }
});

/**
 * Parses a single ffmpeg progress/status line for known fields.
 * Mirrors the mapping in Processor.ts.
 *
 * @param line Progress line from ffmpeg stderr
 * @returns Parsed progress object or null if not parseable
 *
 * @example
 * const progress = parseProgress("frame=100 fps=30.0 bitrate=3200kbits/s ...");
 * if (progress) console.log(progress.frame, progress.fps);
 */
function parseProgress(line: string): Partial<FFmpegProgress> | null {
  const progress: Partial<FFmpegProgress> = {};
  const pairs = line.trim().split(/\s+/);
  for (const pair of pairs) {
    const [key, value] = pair.split("=", 2);
    if (!key || value == null) continue;
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
  return Object.keys(progress).length ? progress : null;
}

/**
 * Exported for advanced Node.js integrations.
 * Allows main thread to register custom PassThrough streams
 * for extra pipe outputs from ffmpeg process in worker.
 *
 * @param pipeNum The pipe number (e.g., 2 for pipe:2)
 * @param stream The PassThrough stream to associate
 *
 * @example
 * import { setExtraOutputStream } from "./ProcessorWorker";
 * setExtraOutputStream(2, myPassThroughStream);
 */
export { setExtraOutputStream };
