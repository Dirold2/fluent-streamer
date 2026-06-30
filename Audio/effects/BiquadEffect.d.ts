import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
import type { AudioEffect } from "./BaseEffect.js";
export declare function calcLowShelfCoeffs(freq: number, sampleRate: number, gainDb: number, Q?: number): BiquadCoeffs;
export declare function calcHighShelfCoeffs(freq: number, sampleRate: number, gainDb: number, Q?: number): BiquadCoeffs;
export declare function calcPeakingCoeffs(freq: number, sampleRate: number, gainDb: number, Q: number): BiquadCoeffs;
export declare function processBiquad(input: number, coeffs: BiquadCoeffs, state: BiquadState): number;
export type BiquadCoeffsFn = () => {
    shelf: BiquadCoeffs;
    peak: BiquadCoeffs | null;
};
export declare class BiquadEffect implements AudioEffect {
    readonly name: string;
    private calcFn;
    private activeFn;
    private coeffs;
    private shelfStates;
    private peakStates;
    constructor(name: string, calcFn: BiquadCoeffsFn, activeFn: () => boolean, channels: number);
    isActive(): boolean;
    invalidate(): void;
    process(samples: Float64Array, channels: number, frames: number): void;
    reset(): void;
}
//# sourceMappingURL=BiquadEffect.d.ts.map