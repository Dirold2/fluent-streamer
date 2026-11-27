import type { ReplayableStreamSource } from "../../Types/index.js";
/** Owns only one run's factory stream; never stores it in processor configuration. */
export declare class FactoryInput {
    private readonly controller;
    private reader?;
    private stopped;
    get signal(): AbortSignal;
    wait<T>(promise: Promise<T>): Promise<T>;
    open(source: ReplayableStreamSource): Promise<void>;
    dispose(): void;
    pipeTo(stdin: WritableStream<Uint8Array>): Promise<void>;
}
//# sourceMappingURL=factory.d.ts.map