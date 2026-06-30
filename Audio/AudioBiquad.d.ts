import type { BiquadCoeffs, BiquadState } from "../Types/audio.js";
export declare function userToGainLinear(userVal: number, maxDb?: number): number;
export declare function userToGainDb(userVal: number, maxDb?: number): number;
export declare function calcLowShelfCoeffs(freq: number, sampleRate: number, gainDb: number, Q?: number): BiquadCoeffs;
export declare function calcPeakingCoeffs(freq: number, sampleRate: number, gainDb: number, Q: number): BiquadCoeffs;
export declare function calcHighShelfCoeffs(freq: number, sampleRate: number, gainDb: number, Q?: number): BiquadCoeffs;
export declare function processBiquad(input: number, coeffs: BiquadCoeffs, state: BiquadState): number;
//# sourceMappingURL=AudioBiquad.d.ts.map