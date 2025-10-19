import { parentPort } from "worker_threads";
import { spawn, type ChildProcess } from "child_process";
import { PassThrough } from "stream";
import { type ProcessorOptions, type FFmpegProgress } from "../Types/index.js";

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
  outputs?: number;
  pipeNum?: number;
}

const extraOutputStreams = new Map<number, PassThrough>();

let ffmpegProcess: ChildProcess | null = null;
let extraOutputIndexes: number[] = [];

/**
 * Logs events and state for debugging process lifecycle and arguments.
 * Used for inspecting process execution and exit.
 */
function logDebug(prefix: string, ...args: any[]) {
  // [ffmpeg_1760884412131] is the sample prefix, but let's make it more generic and include PID if possible.
  const tag =
    ffmpegProcess?.pid != null
      ? `[ffmpeg_${ffmpegProcess.pid}]`
      : `[ffmpeg_worker]`;
  // eslint-disable-next-line no-console
  console.log(tag, prefix, ...args);
}

function _setupOutputStreams(ffmpegProcess: ChildProcess) {
  // Main stdout (pipe:1)
  ffmpegProcess.stdout?.on("data", (chunk) => {
    parentPort?.postMessage({ type: "stdout", data: chunk });
    const stream = extraOutputStreams.get(1);
    if (stream) stream.write(chunk);
  });

  for (let idx = 0; idx < extraOutputIndexes.length; ++idx) {
    const fd = 3 + idx;
    const pipeNum = extraOutputIndexes[idx];
    const stream = ffmpegProcess.stdio[fd] as NodeJS.ReadableStream | undefined;
    if (stream) {
      let pt = extraOutputStreams.get(pipeNum);
      if (!pt) {
        pt = new PassThrough();
        extraOutputStreams.set(pipeNum, pt);
      }
      stream.on("data", (chunk) => {
        parentPort?.postMessage({ type: "stdout", pipe: pipeNum, data: chunk });
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

      // Detect extra pipe outputs ("pipe:2", "pipe:3", etc in args)
      const extraPipes: string[] = [];
      extraOutputIndexes = [];
      for (let i = 2; i < 16; ++i) {
        if (msg.args.includes(`pipe:${i}`)) {
          extraPipes.push("pipe");
          extraOutputIndexes.push(i);
        }
      }

      const stdio = ["pipe", "pipe", "pipe", ...extraPipes];

      // Debug log for process start (args etc)
      logDebug(
        "Starting:",
        (options.ffmpegPath ?? "ffmpeg"),
        ...msg.args
      );

      ffmpegProcess = spawn(options.ffmpegPath ?? "ffmpeg", msg.args, {
        stdio: stdio as any,
      });

      logDebug("PID:", ffmpegProcess.pid);

      _setupOutputStreams(ffmpegProcess);

      ffmpegProcess.stderr?.on("data", (chunk) => {
        parentPort?.postMessage({ type: "stderr", data: chunk });
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
        logDebug("Process exited with code", code, "signal", signal);
        parentPort?.postMessage({ type: "end", code, signal });
        ffmpegProcess = null;
        extraOutputStreams.forEach((pt) => pt.end());
        extraOutputStreams.clear();
      });

      ffmpegProcess.once("close", (code, signal) => {
        logDebug("close event: code=" + code, "signal=" + signal);
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
      if (msg.signal) ffmpegProcess?.kill(msg.signal);
      break;

    case "abortSignal":
      ffmpegProcess?.kill("SIGTERM");
      break;

    case "input":
      if (ffmpegProcess?.stdin && msg.inputData) {
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
      if (typeof msg.pipeNum === "number") {
        let pt = extraOutputStreams.get(msg.pipeNum);
        if (!pt) {
          pt = new PassThrough();
          extraOutputStreams.set(msg.pipeNum, pt);
        }
        parentPort?.postMessage({
          type: "ack-getExtraOutput",
          pipe: msg.pipeNum,
        });
      }
      break;
  }
});

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

export { setExtraOutputStream };
