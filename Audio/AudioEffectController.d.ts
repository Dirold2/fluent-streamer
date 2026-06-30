import type { AudioProcessor } from "../Audio/AudioProcessor.js";
import type { Logger } from "../Types/index.js";
export declare class AudioEffectController {
    private audioProcessor;
    private logger;
    private loggerTag;
    private verbose;
    private _volume;
    private _bass;
    private _treble;
    private _compressor;
    private _normalize;
    constructor(audioProcessor: AudioProcessor, config: {
        logger: Logger;
        loggerTag: string;
        verbose?: boolean;
    }, initialState: {
        volume: number;
        bass: number;
        treble: number;
        compressor: boolean;
        normalize: boolean;
    });
    setVolume(v: number): void;
    setBass(b: number): void;
    setTreble(t: number): void;
    setCompressor(c: boolean): void;
    setNormalize(n: boolean): void;
    startFade(targetVolume: number, durationMs: number): void;
    private canUpdate;
    private logChange;
}
//# sourceMappingURL=AudioEffectController.d.ts.map