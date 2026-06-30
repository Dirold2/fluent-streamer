import type { FFmpegProcess } from "../../Types/core.js";
import { AudioProcessor } from "../../Audio/AudioProcessor.js";
import type { ProcessorConfig } from "./config.js";
export type InputStreamEntry = {
    stream: ReadableStream<Uint8Array>;
    index: number;
};
export type InputPipelineCallbacks = {
    onError: (err: Error) => void;
    hasFinished: () => boolean;
    isTerminating: () => boolean;
};
export type OutputPipelineCallbacks = {
    onError: (err: Error) => void;
    onPipelineComplete: () => void;
    hasFinished: () => boolean;
};
export declare function ensureOutputDrained(output: ReadableStream<Uint8Array>): void;
export declare function pipeInputStreams(process: FFmpegProcess, inputStreams: InputStreamEntry[], callbacks: InputPipelineCallbacks): void;
export declare function createAudioProcessor(config: ProcessorConfig, useAudioProcessor: boolean, volume: number, bass: number, treble: number, compressor: boolean): AudioProcessor;
export type OutputPipelineResult = {
    throttledOutput: TransformStream<Uint8Array, Uint8Array>;
    pipelinePromise: Promise<void> | null;
};
export declare function setupOutputPipeline(process: FFmpegProcess | null, audioProcessor: AudioProcessor, outputStream: TransformStream<Uint8Array, Uint8Array>, config: Pick<ProcessorConfig, "disableThrottling" | "verbose" | "loggerTag" | "logger"> & Pick<ProcessorConfig["audioProcessorOptions"], "sampleRate" | "channels">, callbacks: OutputPipelineCallbacks): OutputPipelineResult;
export declare function updateThrottleBitrate(throttledOutput: TransformStream<Uint8Array, Uint8Array>, kbps: number): void;
//# sourceMappingURL=pipeline.d.ts.map