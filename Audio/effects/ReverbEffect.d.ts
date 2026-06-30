import type { AudioEffect } from "./BaseEffect.js";
export interface ReverbParams {
    decay: number;
    mix: number;
}
export declare class ReverbEffect implements AudioEffect {
    readonly name = "reverb";
    private combBuffers;
    private combPositions;
    private allpassBuffers;
    private allpassPositions;
    private _decay;
    private _mix;
    private _sampleRate;
    constructor(sampleRate: number, channels: number, params?: Partial<ReverbParams>);
    private initBuffers;
    get decay(): number;
    get mix(): number;
    setDecay(v: number): void;
    setMix(v: number): void;
    isActive(): boolean;
    process(samples: Float64Array, channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=ReverbEffect.d.ts.map