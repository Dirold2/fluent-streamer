import type { FFmpegProgress } from "../../Types/index.js";
import { getTimeString } from "../utils.js";
import type { ProcessorConfig } from "./config.js";

export function parseProgressLine(line: string): Partial<FFmpegProgress> | null {
  const progress: Partial<FFmpegProgress> = {};
  const pairs = line.trim().split(/\s+/);

  for (const pair of pairs) {
    const [key, value] = pair.split("=", 2);
    if (!key || value == null) continue;

    switch (key) {
      case "frame":
        progress.frame = Number(value);
        break;
      case "total_size":
        progress.totalSize = Number(value);
        break;
      case "out_time_us":
        progress.outTimeUs = Number(value);
        break;
      case "dup_frames":
        progress.dupFrames = Number(value);
        break;
      case "drop_frames":
        progress.dropFrames = Number(value);
        break;
      case "packet":
        progress.packet = Number(value);
        break;
      case "chapter":
        progress.chapter = Number(value);
        break;
      case "fps":
        progress.fps = parseFloat(value.replace("x", ""));
        break;
      case "speed":
        progress.speed = parseFloat(value.replace("x", ""));
        break;
      case "bitrate":
        progress.bitrate = value;
        break;
      case "size":
        progress.size = value;
        break;
      case "out_time":
        progress.outTime = value;
        break;
      case "progress":
        progress.progress = value;
        break;
      case "time":
        progress.time = value;
        break;
    }
  }

  return Object.keys(progress).length > 0 ? progress : null;
}

export type StderrTrackerCallbacks = {
  onProgress?: (progress: Partial<FFmpegProgress>) => void;
  onBitrateDetected?: (kbps: number) => void;
};

export class StderrTracker {
  private buffer = "";
  private progress: Partial<FFmpegProgress> = {};
  private duration = 180;
  private bitrate = 128;
  private bitrateDetected = false;

  constructor(
    private readonly config: Pick<
      ProcessorConfig,
      "maxStderrBuffer" | "enableProgressTracking" | "verbose" | "loggerTag" | "logger"
    >,
    private readonly callbacks: StderrTrackerCallbacks = {},
  ) {}

  getBuffer(): string {
    return this.buffer;
  }

  getProgress(): Partial<FFmpegProgress> {
    return { ...this.progress };
  }

  getDuration(): number {
    return this.duration;
  }

  getBitrate(): number {
    return this.bitrate;
  }

  isBitrateDetected(): boolean {
    return this.bitrateDetected;
  }

  reset(): void {
    this.buffer = "";
    this.progress = {};
    this.duration = 180;
    this.bitrate = 128;
    this.bitrateDetected = false;
  }

  handleChunk(chunk: Uint8Array): void {
    const text = new TextDecoder().decode(chunk);
    this.appendBuffer(text);
    this.detectDuration(text);
    this.detectBitrate(text);
    this.trackProgress(text);
  }

  private appendBuffer(text: string): void {
    if (this.buffer.length < this.config.maxStderrBuffer) {
      this.buffer += text;
      if (this.buffer.length > this.config.maxStderrBuffer) {
        this.buffer = this.buffer.slice(this.buffer.length - this.config.maxStderrBuffer);
      }
    }
  }

  private detectDuration(text: string): void {
    const durationMatch = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
    if (!durationMatch) return;

    const hours = parseInt(durationMatch[1]!, 10);
    const minutes = parseInt(durationMatch[2]!, 10);
    const seconds = parseInt(durationMatch[3]!, 10);
    const milliseconds = parseInt(durationMatch[4]!.substring(0, 3), 10);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
    this.duration = Math.max(1, Math.min(3600, totalSeconds));

    if (this.config.verbose) {
      this.config.logger.debug?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Detected duration: ${this.duration.toFixed(3)}s`,
      );
    }
  }

  private detectBitrate(text: string): void {
    if (this.bitrateDetected) return;

    const bitrateMatch = text.match(/bitrate=\s*(\d+(?:\.\d+)?)\s*(k(?:b\/s)?|M(?:b\/s)?)/i);
    if (!bitrateMatch) return;

    const value = parseFloat(bitrateMatch[1]!);
    const unit = bitrateMatch[2]!.toLowerCase();
    let bitrateKbps = value;

    if (unit.startsWith("m")) {
      bitrateKbps = value * 1000;
    }

    this.bitrate = Math.max(32, Math.min(320, bitrateKbps));
    this.bitrateDetected = true;
    this.callbacks.onBitrateDetected?.(this.bitrate);

    if (this.config.verbose) {
      this.config.logger.info?.(
        `[${getTimeString()}] [${this.config.loggerTag}] Bitrate detected: ${this.bitrate} kbps`,
      );
    }
  }

  private trackProgress(text: string): void {
    if (!this.config.enableProgressTracking) return;

    const lines = text.split(/[\r\n]+/);
    for (const line of lines) {
      if (line && line.includes("=")) {
        const parsed = parseProgressLine(line);
        if (parsed) {
          this.progress = { ...this.progress, ...parsed };
          this.callbacks.onProgress?.({ ...this.progress });
        }
      }
    }
  }
}

export function buildProcessExitError(
  code: number | null,
  signal: string | null,
  stderrBuffer: string,
): Error {
  const stderrSnippet = stderrBuffer.trim().slice(-1000);
  let message = `FFmpeg exited with code ${code}`;

  if (signal) message += ` (signal ${signal})`;
  if (stderrSnippet) {
    message += `.\nLast stderr output:\n${stderrSnippet}`;
  }

  return new Error(message);
}

export async function readStderrStream(
  stderr: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  logHandler?: (text: string) => void,
): Promise<void> {
  const reader = stderr.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      onChunk(value);
      try {
        logHandler?.(new TextDecoder().decode(value));
      } catch {
        //
      }
    }
  } catch {
    //
  } finally {
    reader.releaseLock();
  }
}
