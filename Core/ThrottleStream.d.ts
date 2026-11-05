export declare class ThrottleStream extends TransformStream<Uint8Array, Uint8Array> {
    private bytesPerSecond;
    private lastTime;
    private pendingTimer;
    private pendingChunk;
    private pendingController;
    private pendingResolve;
    constructor(bytesPerSecond: number);
    updateBitrate(bytesPerSecond: number): void;
    private _cancelPending;
    private _flushPending;
}
//# sourceMappingURL=ThrottleStream.d.ts.map