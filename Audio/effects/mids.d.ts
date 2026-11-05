import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
export declare function normalizeMids(mids: number): number;
export declare class MidsEffect {
    value: number;
    coeffs: BiquadCoeffs | null;
    peakL: BiquadState;
    peakR: BiquadState;
    private readonly smoothing;
    constructor(value?: number);
    get active(): boolean;
    set(mids: number, durationMs?: number): void;
    processStereo(l: number, r: number, channels: number, sampleRate: number): [number, number];
}
//# sourceMappingURL=mids.d.ts.map