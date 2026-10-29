import type { DjAnalysis } from "./DjAnalysisCore.js";
import type { AnalysisRequest, AnalysisResponse } from "./DjAnalysisWorkerProtocol.js";

export interface PcmAnalysisOptions {
  signal?: AbortSignal;
  /** Total worker deadline in milliseconds, including startup. Defaults to 25000. */
  timeout?: number;
}

/** Internal transport. Every job owns its worker and terminates it before settling. */
export function runAnalysisWorker(
  request: () => AnalysisRequest,
  options: PcmAnalysisOptions = {},
): Promise<DjAnalysis> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout ?? 25000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      reject(new RangeError("timeout must be finite and positive"));
      return;
    }
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }
    let settled = false;
    let terminate: (() => void | Promise<unknown>) | undefined;
    let removeListeners = () => {};
    const finish = async (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Keep the error listener installed until termination completes.
      try {
        await terminate?.();
      } catch (error) {
        success = false;
        value = error;
      } finally {
        removeListeners();
      }
      if (success) resolve(value as DjAnalysis);
      else reject(value);
    };
    const onAbort = () => {
      void finish(false, options.signal?.reason);
    };
    const timer = setTimeout(() => {
      void finish(false, new Error("DJ analysis timed out"));
    }, timeout);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const onMessage = (response: AnalysisResponse) => {
      if (response.ok) void finish(true, response.result);
      else {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        void finish(false, error);
      }
    };
    void (async () => {
      // Published builds always resolve the separate compiled .js entry. Native
      // TS runtimes can also run a source checkout without a Vitest worker loader.
      const source = import.meta.url.endsWith(".ts");
      const url = new URL(
        source ? "./DjAnalysisWorker.ts" : "./DjAnalysisWorker.js",
        import.meta.url,
      );
      const node =
        typeof process !== "undefined" && process.versions?.node && !process.versions?.bun;
      if (node) {
        const { Worker } = await import("node:worker_threads");
        if (settled) return;
        if (source) {
          const [major, minor] = process.versions.node.split(".").map(Number);
          if (major! < 22 || (major === 22 && minor! < 18))
            throw new Error("Source DJ workers require Node >=22.18; build the package first");
        }
        const worker = new Worker(url, { execArgv: [] });
        terminate = () => worker.terminate();
        const error = (cause: Error) => {
          void finish(false, cause);
        };
        const exit = (code: number) => {
          void finish(
            false,
            new Error(`DJ analysis worker exited before responding (code ${code})`),
          );
        };
        worker.on("message", onMessage);
        worker.on("error", error);
        worker.on("messageerror", error);
        worker.on("exit", exit);
        removeListeners = () => {
          worker.off("message", onMessage);
          worker.off("error", error);
          worker.off("messageerror", error);
          worker.off("exit", exit);
        };
        const message = request();
        worker.postMessage(message, [message.buffer]);
      } else {
        if (typeof globalThis.Worker !== "function")
          throw new Error("Off-thread DJ analysis is unsupported: no Worker implementation");
        if (settled) return;
        const worker = new globalThis.Worker(url.href, { type: "module" });
        terminate = () => worker.terminate();
        worker.onmessage = (event: MessageEvent<AnalysisResponse>) => onMessage(event.data);
        worker.onerror = (event: ErrorEvent) => {
          event.preventDefault();
          void finish(false, new Error(event.message || "DJ analysis worker failed"));
        };
        worker.onmessageerror = () => {
          void finish(false, new Error("DJ analysis worker message failed"));
        };
        removeListeners = () => {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
        };
        const message = request();
        worker.postMessage(message, [message.buffer]);
      }
    })().catch((error: unknown) => {
      void finish(false, error);
    });
  });
}
