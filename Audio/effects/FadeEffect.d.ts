import { EventEmitter } from "eventemitter3";
import type { AudioEffect } from "./BaseEffect.js";
export declare class FadeEffect extends EventEmitter implements AudioEffect {
    readonly name = "fade";
    private _active;
    private _from;
    private _to;
    private _samplesTotal;
    private _samplesDone;
    private _sampleRate;
    private _volume;
    constructor(volume: number, sampleRate: number);
    get volume(): number;
    get active(): boolean;
    setVolume(v: number): void;
    startFade(targetVolume: number, durationMs: number): void;
    isActive(): boolean;
    process(samples: Float64Array, channels: number, _frames: number): void;
    reset(): void;
}
//# sourceMappingURL=FadeEffect.d.ts.map