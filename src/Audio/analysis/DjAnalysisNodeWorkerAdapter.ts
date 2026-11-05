import type { AnalysisRequest, AnalysisResponse } from "./DjAnalysisWorkerProtocol.js";

export function isNodeAnalysisRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node && !process.versions?.bun;
}

export async function startNodeAnalysisWorker(
  url: URL,
  source: boolean,
  isSettled: () => boolean,
  register: (terminate: () => Promise<number>, removeListeners: () => void) => void,
  onMessage: (response: AnalysisResponse) => void,
  onError: (error: Error) => void,
  request: () => AnalysisRequest,
): Promise<void> {
  const { Worker } = await import("node:worker_threads");
  if (isSettled()) return;
  if (source) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major! < 22 || (major === 22 && minor! < 18))
      throw new Error("Source DJ workers require Node >=22.18; build the package first");
  }
  const worker = new Worker(url, { execArgv: [] });
  const exit = (code: number) =>
    onError(new Error(`DJ analysis worker exited before responding (code ${code})`));
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("messageerror", onError);
  worker.on("exit", exit);
  register(
    () => worker.terminate(),
    () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("messageerror", onError);
      worker.off("exit", exit);
    },
  );
  const message = request();
  worker.postMessage(message, [message.buffer]);
}
