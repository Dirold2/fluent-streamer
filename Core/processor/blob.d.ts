import type { Logger } from "../../Types/index.js";
export declare function createStreamFromArrayBuffer(arrayBuffer: ArrayBuffer): ReadableStream<Uint8Array>;
export declare function validateAudioData(arrayBuffer: ArrayBuffer): boolean;
export declare function resolveBlobToStream(blobUrl: string, log?: {
    verbose: boolean;
    loggerTag: string;
    logger?: Logger;
}): Promise<ReadableStream<Uint8Array>>;
//# sourceMappingURL=blob.d.ts.map