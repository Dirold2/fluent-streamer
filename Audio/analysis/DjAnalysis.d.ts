import type { ProcessorOptions, ReplayableInput } from "../../Types/index.js";
import type { DjAnalysis } from "./DjAnalysisCore.js";
export { analyzePcm } from "./DjAnalysisCore.js";
export type { DjAnalysis } from "./DjAnalysisCore.js";
export type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";
import type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";
export type DjAnalysisOptions = Pick<ProcessorOptions, "ffmpegPath" | "headers" | "timeout"> & {
    signal?: AbortSignal;
    /** Decode a 90-second analysis window starting at this absolute source time. Results remain window-relative. */
    startSeconds?: number;
};
/** Analyze a dedicated copy in a worker; the caller's input is never transferred. */
export declare function analyzePcmAsync(samples: Int16Array, sampleRate: number, options?: PcmAnalysisOptions): Promise<DjAnalysis>;
/** Decode through the runtime-selected Processor, never a Node-specific subprocess. */
export declare function analyzeTrack(source: ReplayableInput, options?: DjAnalysisOptions): Promise<DjAnalysis>;
//# sourceMappingURL=DjAnalysis.d.ts.map