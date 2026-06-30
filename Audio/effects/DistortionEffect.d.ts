import type { AudioEffect } from "./BaseEffect.js";
export interface DistortionParams {
    drive: number;
    outputGain: number;
}
export declare class DistortionEffect implements AudioEffect {
    readonly name = "distortion";
    private _drive;
    private _outputGain;
    constructor(params?: Partial<DistortionParams>);
    get drive(): number;
    get outputGain(): number;
    setDrive(v: number): void;
    setOutputGain(v: number): void;
    isActive(): boolean;
    process(samples: Float64Array, _channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=DistortionEffect.d.ts.map