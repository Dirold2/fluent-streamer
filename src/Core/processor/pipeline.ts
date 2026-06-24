import type { FFmpegProcess } from "../../Types/core.js";
import { AudioProcessor } from "../../Audio/AudioProcessor.js";
import { ThrottleStream } from "../ThrottleStream.js";
import { getTimeString } from "../utils.js";
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

export function ensureOutputDrained(output: ReadableStream<Uint8Array>): void {
  setTimeout(() => {
    if (output.locked) return;
    output.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  }, 100);
}

export function pipeInputStreams(
  process: FFmpegProcess,
  inputStreams: InputStreamEntry[],
  callbacks: InputPipelineCallbacks,
): void {
  if (!process.stdin || !inputStreams.length) return;

  if (inputStreams.length > 1) {
    const error = new Error(
      "Multiple stream inputs are not supported. Provide additional inputs as file paths or URLs.",
    );
    callbacks.onError(error);
    throw error;
  }

  const primary = inputStreams[0]!;
  const inputThrottle = new ThrottleStream(32_000);
  primary.stream
    .pipeThrough(inputThrottle)
    .pipeTo(process.stdin)
    .catch((err) => {
      const code = (err as Error & { code?: string })?.code;
      if (code === "EPIPE" && (callbacks.hasFinished() || callbacks.isTerminating())) return;
      callbacks.onError(err as Error);
    });
}

export function createAudioProcessor(
  config: ProcessorConfig,
  useAudioProcessor: boolean,
  volume: number,
  bass: number,
  treble: number,
  compressor: boolean,
): AudioProcessor {
  const sampleRate = config.audioProcessorOptions?.sampleRate ?? 48000;
  const channels = config.audioProcessorOptions?.channels ?? 2;

  const audioProcessor = new AudioProcessor({
    volume,
    bass,
    treble,
    compressor,
    normalize: false,
    sampleRate,
    channels,
  });

  if (!useAudioProcessor) {
    audioProcessor.setVolume(1);
    audioProcessor.setEqualizer(0, 0, false);
  }

  return audioProcessor;
}

export type OutputPipelineResult = {
  throttledOutput: TransformStream<Uint8Array, Uint8Array>;
  pipelinePromise: Promise<void> | null;
};

export function setupOutputPipeline(
  process: FFmpegProcess | null,
  audioProcessor: AudioProcessor,
  outputStream: TransformStream<Uint8Array, Uint8Array>,
  config: Pick<ProcessorConfig, "disableThrottling" | "verbose" | "loggerTag" | "logger"> &
    Pick<ProcessorConfig["audioProcessorOptions"], "sampleRate" | "channels">,
  callbacks: OutputPipelineCallbacks,
): OutputPipelineResult {
  const sampleRate = config.sampleRate ?? 48000;
  const channels = config.channels ?? 2;
  const bytesPerSecond = sampleRate * channels * 2;

  const throttledOutput = config.disableThrottling
    ? new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      })
    : new ThrottleStream(bytesPerSecond);

  if (!process?.stdout) {
    outputStream.writable.close();
    return { throttledOutput, pipelinePromise: null };
  }

  const pipelinePromise = process.stdout
    .pipeThrough(audioProcessor)
    .pipeThrough(throttledOutput)
    .pipeTo(outputStream.writable)
    .then(() => {
      callbacks.onPipelineComplete();
      if (config.verbose) {
        config.logger.debug?.(
          `[${getTimeString()}] [${config.loggerTag}] Output pipeline completed`,
        );
      }
    })
    .catch((err) => {
      if (!callbacks.hasFinished()) {
        callbacks.onError(err as Error);
      }
    });

  return { throttledOutput, pipelinePromise };
}

export function updateThrottleBitrate(
  throttledOutput: TransformStream<Uint8Array, Uint8Array>,
  kbps: number,
): void {
  if (throttledOutput instanceof ThrottleStream) {
    const bytesPerSecond = (kbps * 1000) / 8;
    throttledOutput.updateBitrate(bytesPerSecond);
  }
}
