import type { AudioEffect } from "./BaseEffect.js";
export interface DelayParams {
    delayTime: number;
    feedback: number;
    mix: number;
}
export declare class DelayEffect implements AudioEffect {
    readonly name = "delay";
    private buffers;
    private writePositions;
    private _delayTime;
    private _feedback;
    private _mix;
    private _sampleRate;
    private _delaySamples;
    constructor(sampleRate: number, channels: number, params?: Partial<DelayParams>);
    private initBuffers;
    get delayTime(): number;
    get feedback(): number;
    get mix(): number;
    setDelayTime(ms: number): void;
    setFeedback(v: number): void;
    setMix(v: number): void;
    isActive(): boolean;
    process(samples: Float64Array, channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=DelayEffect.d.ts.map