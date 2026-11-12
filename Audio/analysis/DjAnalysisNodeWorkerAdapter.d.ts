import type { AnalysisRequest, AnalysisResponse } from "./DjAnalysisWorkerProtocol.js";
export declare function isNodeAnalysisRuntime(): boolean;
export declare function startNodeAnalysisWorker(url: URL, source: boolean, isSettled: () => boolean, register: (terminate: () => Promise<number>, removeListeners: () => void) => void, onMessage: (response: AnalysisResponse) => void, onError: (error: Error) => void, request: () => AnalysisRequest): Promise<void>;
//# sourceMappingURL=DjAnalysisNodeWorkerAdapter.d.ts.map