import type { FFmpegProgress } from "../../Types/index.js";
import type { ProcessorConfig } from "./config.js";
export declare function parseProgressLine(line: string): Partial<FFmpegProgress> | null;
export type StderrTrackerCallbacks = {
    onProgress?: (progress: Partial<FFmpegProgress>) => void;
    onBitrateDetected?: (kbps: number) => void;
};
export declare class StderrTracker {
    private readonly config;
    private readonly callbacks;
    private buffer;
    private progress;
    private duration;
    private bitrate;
    private bitrateDetected;
    constructor(config: Pick<ProcessorConfig, "maxStderrBuffer" | "enableProgressTracking" | "verbose" | "loggerTag" | "logger">, callbacks?: StderrTrackerCallbacks);
    getBuffer(): string;
    getProgress(): Partial<FFmpegProgress>;
    getDuration(): number;
    getBitrate(): number;
    isBitrateDetected(): boolean;
    reset(): void;
    handleChunk(chunk: Uint8Array): void;
    private appendBuffer;
    private detectDuration;
    private detectBitrate;
    private trackProgress;
}
export declare function buildProcessExitError(code: number | null, signal: string | null, stderrBuffer: string): Error;
export declare function readStderrStream(stderr: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void, logHandler?: (text: string) => void, onError?: (err: Error) => void): Promise<void>;
//# sourceMappingURL=stderr.d.ts.map