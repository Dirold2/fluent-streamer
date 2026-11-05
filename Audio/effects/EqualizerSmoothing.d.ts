import type { BiquadCoeffs } from "../../Types/audio.js";
/** Gain ramps use audio frames, not calls to set(), channels or wall-clock time. */
export declare class EqualizerSmoothing {
    private readonly design;
    private gain;
    private target;
    private durationMs;
    private remaining;
    private sampleRate;
    private segmentRemaining;
    private destination;
    private increments;
    private coefficients;
    constructor(design: (gainDb: number, sampleRate: number) => BiquadCoeffs[]);
    get active(): boolean;
    set(gainDb: number, durationMs: number): void;
    next(sampleRate: number): BiquadCoeffs[];
}
/** Fade the auxiliary bell in over 1 dB instead of switching a nonzero bell on. */
export declare function auxiliaryPeakGain(gainDb: number, threshold: number, amount: number): number;
//# sourceMappingURL=EqualizerSmoothing.d.ts.map