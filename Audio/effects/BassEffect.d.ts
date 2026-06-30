import { BiquadEffect } from "./BiquadEffect.js";
export declare class BassEffect extends BiquadEffect {
    private _normalized;
    private _sampleRate;
    constructor(channels: number, sampleRate: number, normalized: number);
    get value(): number;
    setBass(v: number): void;
}
//# sourceMappingURL=BassEffect.d.ts.map