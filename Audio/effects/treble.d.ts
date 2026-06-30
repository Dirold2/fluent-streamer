import type { BiquadCoeffs, BiquadState } from "../../Types/audio.js";
export declare function normalizeTreble(treble: number): number;
export declare class TrebleEffect {
    value: number;
    coeffs: {
        shelf: BiquadCoeffs;
        peak: BiquadCoeffs | null;
    } | null;
    shelfL: BiquadState;
    shelfR: BiquadState;
    peakL: BiquadState;
    peakR: BiquadState;
    set(treble: number): void;
    processStereo(l: number, r: number, channels: number, sampleRate: number): [number, number];
}
//# sourceMappingURL=treble.d.ts.map