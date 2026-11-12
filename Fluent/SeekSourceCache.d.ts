/** A bounded, per-stream compressed source cache. It never delays live decoding. */
export declare class SeekSourceCache {
    private readonly url;
    private readonly headers;
    private readonly maxBytes;
    private readonly files;
    private readonly client;
    private readonly abort;
    private pending?;
    private disposal?;
    private directory?;
    private failed;
    constructor(url: string, headers: Record<string, string>, maxBytes: number);
    start(): void;
    private download;
    status(): "loading" | "ready" | "miss";
    /** Returns immediately on a miss; never wait for the network while seeking. */
    localPath(): Promise<string | undefined>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=SeekSourceCache.d.ts.map