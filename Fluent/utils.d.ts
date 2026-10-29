import type { InputSource } from "../Types/index.js";
export declare function getStackTrace(skip?: number): string;
export declare function countInputs(args: string[], inputStreams: Array<{
    stream: ReadableStream<Uint8Array>;
    index: number;
}>, inputSources: InputSource[]): {
    streams: number;
    stringInputs: number;
    urlInputs: number;
    total: number;
};
export declare function summarizeInputs(args: string[], _inputStreams: Array<{
    stream: ReadableStream<Uint8Array>;
    index: number;
}>, complexFilters: string[], inputSources: InputSource[]): {
    stringInputs: string[];
    urlInputs: string[];
    pipeStreams: string[];
    complexFilters: string[];
};
//# sourceMappingURL=utils.d.ts.map