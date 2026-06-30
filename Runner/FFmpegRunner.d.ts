import type { Runtime, FFmpegRunner } from "../Types/core.js";
/**
 * Determines the current runtime at module load time.
 * Detection order: Bun → Deno → Browser → Node.
 * Browser is checked before Node because browser polyfills may define `process`.
 */
export declare const CURRENT_RUNTIME: Runtime;
export declare function getFFmpegRunner(): Promise<FFmpegRunner>;
export declare function resolveBlobUrl(blobUrl: string): Promise<ArrayBuffer>;
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
export declare class FFmpegManager {
    private runner;
    private promise;
    constructor(custom?: FFmpegRunner);
    getSync(): FFmpegRunner | null;
    ensure(): Promise<FFmpegRunner>;
    get(): FFmpegRunner | Promise<FFmpegRunner>;
    destroy(): void;
}
/** Module-level singleton {@link FFmpegManager}. */
export declare const ffmpegManager: FFmpegManager;
//# sourceMappingURL=FFmpegRunner.d.ts.map