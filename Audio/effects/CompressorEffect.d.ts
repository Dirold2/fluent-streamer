import type { AudioEffect } from "./BaseEffect.js";
export declare class CompressorEffect implements AudioEffect {
    readonly name = "compressor";
    private _enabled;
    constructor(enabled: boolean);
    get enabled(): boolean;
    setEnabled(v: boolean): void;
    isActive(): boolean;
    process(samples: Float64Array, _channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=CompressorEffect.d.ts.map