import { logMessage } from "./logging.js";
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
  signal?: AbortSignal;
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
  primary.stream.pipeTo(process.stdin).catch((err) => {
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
  mids: number = 0,
  karaoke: boolean = config.audioProcessorOptions?.karaoke ?? false,
): AudioProcessor {
  const sampleRate = config.audioProcessorOptions?.sampleRate ?? 48000;
  const channels = config.audioProcessorOptions?.channels ?? 2;

  const audioProcessor = new AudioProcessor({
    volume,
    bass,
    treble,
    mids,
    karaoke: useAudioProcessor && karaoke,
    compressor,
    normalize: config.audioProcessorOptions?.normalize ?? false,
    sampleRate,
    channels,
  });

  if (!useAudioProcessor) {
    audioProcessor.setVolume(1);
    audioProcessor.setEqualizer(0, 0, false);
    audioProcessor.setMids(0);
  }

  return audioProcessor;
}

// Keep native stdout chunks raw until downstream requests each small DSP block.
// A transform that enqueues all slices would still process the whole track ahead.
export function splitPcmStream(
  source: ReadableStream<Uint8Array>,
  sampleRate: number,
  channels: number,
): ReadableStream<Uint8Array> {
  const frameBytes = channels * 2;
  const blockBytes = Math.max(1, Math.floor(sampleRate / 50)) * frameBytes;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let stopped = false;

  const release = () => {
    if (!reader) return;
    try {
      reader.releaseLock();
      reader = undefined;
    } catch {
      // A native read may still be pending; its pull finally retries cleanup.
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          reader ??= source.getReader();
          while (!chunk || offset === chunk.byteLength) {
            chunk = undefined;
            offset = 0;
            const result = await reader.read();
            if (stopped) return;
            if (result.done) {
              stopped = true;
              controller.close();
              return;
            }
            chunk = result.value;
          }
          const end = Math.min(offset + blockBytes, chunk.byteLength);
          controller.enqueue(chunk.subarray(offset, end));
          offset = end;
          if (offset === chunk.byteLength) chunk = undefined;
        } catch (err) {
          if (!stopped) {
            stopped = true;
            controller.error(err);
          }
        } finally {
          if (stopped) {
            chunk = undefined;
            release();
          }
        }
      },
      async cancel(reason) {
        stopped = true;
        chunk = undefined;
        try {
          if (reader) await reader.cancel(reason);
          else await source.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
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

  const pipelinePromise = splitPcmStream(process.stdout, sampleRate, channels)
    // Abort every link: aborting only the final pipe can wait forever for an
    // upstream transform write whose readable side is backpressured.
    .pipeThrough(audioProcessor, { signal: callbacks.signal })
    .pipeThrough(throttledOutput, { signal: callbacks.signal })
    .pipeTo(outputStream.writable, { signal: callbacks.signal })
    .then(() => {
      callbacks.onPipelineComplete();
      logMessage(
        config,
        "debug",
        `[${getTimeString()}] [${config.loggerTag}] Output pipeline completed`,
      );
    })
    .catch((err) => {
      if (!callbacks.hasFinished() && !callbacks.signal?.aborted) {
        callbacks.onError(err as Error);
      }
    });

  return { throttledOutput, pipelinePromise };
}
