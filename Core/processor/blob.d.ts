export declare function createStreamFromArrayBuffer(arrayBuffer: ArrayBuffer): ReadableStream<Uint8Array>;
export declare function validateAudioData(arrayBuffer: ArrayBuffer): boolean;
export declare function resolveBlobToStream(blobUrl: string, log?: {
    verbose: boolean;
    loggerTag: string;
    logger: {
        info?: (msg: string) => void;
    };
}): Promise<ReadableStream<Uint8Array>>;
//# sourceMappingURL=blob.d.ts.map