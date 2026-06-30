import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
export declare function normalizeBass(bass: number): number;
export declare class BassEffect {
    value: number;
    coeffs: {
        shelf: BiquadCoeffs;
        peak: BiquadCoeffs | null;
    } | null;
    shelfL: BiquadState;
    shelfR: BiquadState;
    peakL: BiquadState;
    peakR: BiquadState;
    set(bass: number): void;
    processStereo(l: number, r: number, channels: number, sampleRate: number): [number, number];
}
//# sourceMappingURL=bass.d.ts.map