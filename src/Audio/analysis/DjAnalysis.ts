import { Processor } from "../../Core/Processor.js";
import type { ProcessorOptions } from "../../Types/index.js";

import type { DjAnalysis } from "./DjAnalysisCore.js";
import { runAnalysisWorker } from "./DjAnalysisWorkerClient.js";
export { analyzePcm } from "./DjAnalysisCore.js";
export type { DjAnalysis } from "./DjAnalysisCore.js";
export type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";
import type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";

export type DjAnalysisOptions = Pick<ProcessorOptions, "ffmpegPath" | "headers" | "timeout"> & {
  signal?: AbortSignal;
};

const RATE = 4000;
const MAX_BYTES = 90 * RATE * 2;

/** Analyze a dedicated copy in a worker; the caller's input is never transferred. */
export async function analyzePcmAsync(
  samples: Int16Array,
  sampleRate: number,
  options: PcmAnalysisOptions = {},
): Promise<DjAnalysis> {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new RangeError("sampleRate must be finite and positive");
  return runAnalysisWorker(
    () => ({
      format: "samples",
      buffer: samples.slice(0, Math.floor(sampleRate * 90)).buffer,
      sampleRate,
    }),
    options,
  );
}

/** Decode through the runtime-selected Processor, never a Node-specific subprocess. */
export async function analyzeTrack(
  source: string,
  options: DjAnalysisOptions = {},
): Promise<DjAnalysis> {
  options.signal?.throwIfAborted();
  const timeout = options.timeout ?? 25000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new RangeError("timeout must be finite and positive");
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error("DJ analysis timed out")), timeout);
  const processor = new Processor({
    ffmpegPath: options.ffmpegPath,
    headers: options.headers,
    timeout,
    abortSignal: abort.signal,
    autoDrainOutput: false,
    disableThrottling: true,
    ffmpegLogLevel: "error",
    logger: { debug() {}, info() {}, log() {}, warn() {}, error() {} },
  });
  // Processor's URL source adds HTTP reconnect flags, which local inputs reject.
  const http = /^https?:\/\//i.test(source);
  if (http) processor.setInputSources([{ type: "url", url: source, index: 0 }]);
  processor.setArgs([
    ...(http ? [] : ["-i", source]),
    "-t",
    "90",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "4000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let done: Promise<void> | undefined;
  const bytes = new Uint8Array(MAX_BYTES);
  let size = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(abort.signal.reason);
    void processor.kill().catch(() => {});
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  const starting = processor.run();
  // If startup outlives the deadline, dispose its eventual process as well.
  void starting.then(
    async (run) => {
      void run.done.catch(() => {});
      if (abort.signal.aborted) await processor.close().catch(() => {});
    },
    () => {},
  );
  try {
    const run = await Promise.race([starting, aborted]);
    done = run.done;
    // Observe process failure immediately, even while a read is pending.
    void done.catch(() => {});
    abort.signal.throwIfAborted();
    reader = run.output.getReader();
    const failed = done.then(() => new Promise<never>(() => {}));
    while (true) {
      const chunk = await Promise.race([reader.read(), failed, aborted]);
      if (chunk.done) break;
      if (size + chunk.value.byteLength > MAX_BYTES)
        throw new Error("Decoded PCM exceeds 90 second limit");
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    await Promise.race([done, aborted]);
    abort.signal.throwIfAborted();
    return await runAnalysisWorker(
      () => ({
        format: "s16le",
        buffer: bytes.buffer,
        byteLength: size,
        sampleRate: RATE,
      }),
      { signal: abort.signal, timeout },
    );
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    abort.signal.removeEventListener("abort", onAbort);
    if (reader) {
      const reason = new Error("DJ analysis reader cleanup");
      processor.prepareOutputCancellation(reason);
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    }
    await processor.close().catch(() => {});
    await done?.catch(() => {});
  }
}
