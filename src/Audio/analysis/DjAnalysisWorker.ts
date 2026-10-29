// Native TS runtimes do not rewrite .js specifiers to .ts like the test runner.
// Install the message handler before awaiting module initialization: Bun can
// deliver the parent's first request while the dynamic import is still pending.
const core: Promise<typeof import("./DjAnalysisCore.js")> = import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./DjAnalysisCore.ts" : "./DjAnalysisCore.js",
    import.meta.url,
  ).href
);
void core.catch(() => {});
import type { AnalysisRequest, AnalysisResponse } from "./DjAnalysisWorkerProtocol.js";

async function analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
  try {
    const { analyzePcm } = await core;
    let pcm: Int16Array;
    if (request.format === "s16le") {
      const length = Math.min(
        Math.floor((request.byteLength ?? request.buffer.byteLength) / 2),
        Math.floor(request.sampleRate * 90),
      );
      pcm = new Int16Array(length);
      const bytes = new DataView(request.buffer);
      for (let i = 0; i < length; i++) pcm[i] = bytes.getInt16(i * 2, true);
    } else {
      pcm = new Int16Array(request.buffer);
    }
    return { ok: true, result: analyzePcm(pcm, request.sampleRate) };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

if (typeof process !== "undefined" && process.versions?.node && !process.versions?.bun) {
  const { parentPort } = await import("node:worker_threads");
  if (!parentPort) throw new Error("DJ analysis worker requires a worker context");
  parentPort.once("message", async (request: AnalysisRequest) =>
    parentPort.postMessage(await analyze(request)),
  );
} else {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<AnalysisRequest>) => void;
    postMessage: (response: AnalysisResponse) => void;
  };
  scope.onmessage = async (event) => scope.postMessage(await analyze(event.data));
}
