import type { Runtime, FFmpegRunner, RunnerCtor, RunnerDef } from "../Types/core.js";

/**
 * Determines the current runtime at module load time.
 * Detection order: Bun → Deno → Browser → Node.
 * Browser is checked before Node because browser polyfills may define `process`.
 */
export const CURRENT_RUNTIME: Runtime = (() => {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  if (typeof window !== "undefined") return "browser";
  return "node";
})();

const RUNNER_DEFS: readonly RunnerDef[] = Object.freeze([
  {
    name: "Bun",
    runtime: ["bun"],
    path: "./runners/bun.js",
    export: "BunFFmpegRunner",
    priority: 100,
  },
  {
    name: "Deno",
    runtime: ["deno"],
    path: "./runners/deno.js",
    export: "DenoFFmpegRunner",
    priority: 90,
  },
  {
    name: "Node",
    runtime: ["node"],
    path: "./runners/node.js",
    export: "NodeFFmpegRunner",
    priority: 80,
  },
  {
    name: "Browser",
    runtime: ["browser"],
    path: "./runners/browser.js",
    export: "BrowserFFmpegRunner",
    priority: 70,
  },
]);

const CANDIDATES = RUNNER_DEFS.filter((d) => d.runtime.includes(CURRENT_RUNTIME)).sort(
  (a, b) => b.priority - a.priority,
);

let resolvedCtor: RunnerCtor | null = null;

function isModuleNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const code = e.code as string | undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(e.message ?? "");
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Failed to resolve") ||
    msg.includes("Failed to load")
  );
}

/**
 * Load a runner constructor for the given definition.
 *
 * - In browser runtime: only the Browser runner is attempted, using a static
 *   import path so Vite and other bundlers can analyse it.
 * - In other runtimes: `import.meta.resolve` is tried first as a pre-check,
 *   then a dynamic import of the resolved specifier.
 * - Real errors (not module-not-found) are propagated so they are not silently
 *   hidden during development.
 */
async function loadCtor(def: RunnerDef): Promise<RunnerCtor | null> {
  try {
    let mod: Record<string, unknown>;

    if (CURRENT_RUNTIME === "browser") {
      if (def.path !== "./runners/browser.js") return null;
      mod = (await import("./runners/browser.js")) as Record<string, unknown>;
    } else if (CURRENT_RUNTIME === "node") {
      mod = (await import("./runners/node.js")) as Record<string, unknown>;
    } else if (CURRENT_RUNTIME === "deno") {
      mod = (await import("./runners/deno.js")) as Record<string, unknown>;
    } else if (CURRENT_RUNTIME === "bun") {
      mod = (await import("./runners/bun.js")) as Record<string, unknown>;
    } else {
      return null;
    }

    const ctor = mod[def.export] ?? mod.default;
    return typeof ctor === "function" ? (ctor as RunnerCtor) : null;
  } catch (err) {
    if (isModuleNotFoundError(err)) return null;
    throw err;
  }
}

export async function getFFmpegRunner(): Promise<FFmpegRunner> {
  if (resolvedCtor) return new resolvedCtor();

  for (const def of CANDIDATES) {
    const ctor = await loadCtor(def);
    if (ctor) {
      resolvedCtor = ctor;
      return new ctor();
    }
  }

  throw new Error(`No compatible FFmpegRunner for runtime="${CURRENT_RUNTIME}"`);
}

export async function resolveBlobUrl(blobUrl: string): Promise<ArrayBuffer> {
  const runner = await getFFmpegRunner();
  if (runner.resolveBlobUrl) {
    return runner.resolveBlobUrl(blobUrl);
  }
  try {
    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    return response.arrayBuffer();
  } catch {
    throw new Error(`Blob URL resolution failed: ${blobUrl}`);
  }
}

/**
 * Lazy-initialising manager for the platform-appropriate FFmpegRunner.
 *
 * Mirrors the {@link TransportManager} pattern from hyperttp:
 * - `getSync()` — synchronously return the cached runner (or `null`).
 * - `ensure()` — return a {@link Promise} that resolves to the runner,
 *   initialising it on the first call.
 * - `get()` — convenience union that returns the runner synchronously if
 *   already initialised, otherwise a promise.
 * - `destroy()` — clear the cached state so the next `ensure()` re-resolves.
 */
export class FFmpegManager {
  private runner: FFmpegRunner | null = null;
  private promise: Promise<FFmpegRunner> | null = null;
  constructor(custom?: FFmpegRunner) {
    if (custom) this.runner = custom;
  }

  getSync(): FFmpegRunner | null {
    return this.runner;
  }

  ensure(): Promise<FFmpegRunner> {
    if (this.runner !== null) {
      this.promise ??= Promise.resolve(this.runner);
      return this.promise;
    }
    if (this.promise !== null) return this.promise;
    return (this.promise = getFFmpegRunner().then((r) => {
      this.runner = r;
      return r;
    }));
  }

  get(): FFmpegRunner | Promise<FFmpegRunner> {
    return this.runner ?? this.ensure();
  }

  destroy(): void {
    this.runner = null;
    this.promise = null;
  }
}

/** Module-level singleton {@link FFmpegManager}. */
export const ffmpegManager = new FFmpegManager();
