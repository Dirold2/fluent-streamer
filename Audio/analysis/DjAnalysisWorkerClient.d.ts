import type { DjAnalysis } from "./DjAnalysisCore.js";
import type { AnalysisRequest } from "./DjAnalysisWorkerProtocol.js";
export interface PcmAnalysisOptions {
    signal?: AbortSignal;
    /** Total worker deadline in milliseconds, including startup. Defaults to 25000. */
    timeout?: number;
}
/** Internal transport. Every job owns its worker and terminates it before settling. */
export declare function runAnalysisWorker(request: () => AnalysisRequest, options?: PcmAnalysisOptions): Promise<DjAnalysis>;
//# sourceMappingURL=DjAnalysisWorkerClient.d.ts.map