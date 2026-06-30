import type { AudioEffect } from "./BaseEffect.js";
export declare class VolumeEffect implements AudioEffect {
    readonly name = "volume";
    private _volume;
    constructor(volume: number);
    get volume(): number;
    setVolume(v: number): void;
    isActive(): boolean;
    process(samples: Float64Array, _channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=VolumeEffect.d.ts.map