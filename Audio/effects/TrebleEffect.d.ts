import { BiquadEffect } from "./BiquadEffect.js";
export declare class TrebleEffect extends BiquadEffect {
    private _normalized;
    private _sampleRate;
    constructor(channels: number, sampleRate: number, normalized: number);
    get value(): number;
    setTreble(v: number): void;
}
//# sourceMappingURL=TrebleEffect.d.ts.map