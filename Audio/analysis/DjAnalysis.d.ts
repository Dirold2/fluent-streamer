import type { ProcessorOptions } from "../../Types/index.js";
import type { DjAnalysis } from "./DjAnalysisCore.js";
export { analyzePcm } from "./DjAnalysisCore.js";
export type { DjAnalysis } from "./DjAnalysisCore.js";
export type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";
import type { PcmAnalysisOptions } from "./DjAnalysisWorkerClient.js";
export type DjAnalysisOptions = Pick<ProcessorOptions, "ffmpegPath" | "headers" | "timeout"> & {
    signal?: AbortSignal;
};
/** Analyze a dedicated copy in a worker; the caller's input is never transferred. */
export declare function analyzePcmAsync(samples: Int16Array, sampleRate: number, options?: PcmAnalysisOptions): Promise<DjAnalysis>;
/** Decode through the runtime-selected Processor, never a Node-specific subprocess. */
export declare function analyzeTrack(source: string, options?: DjAnalysisOptions): Promise<DjAnalysis>;
//# sourceMappingURL=DjAnalysis.d.ts.map