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
    private _mids;
    private _compressor;
    private _normalize;
    private _karaoke;
    constructor(audioProcessor: AudioProcessor, config: {
        logger: Logger;
        loggerTag: string;
        verbose?: boolean;
    }, initialState: {
        volume: number;
        bass: number;
        treble: number;
        mids?: number;
        compressor: boolean;
        normalize: boolean;
        karaoke?: boolean;
    });
    setVolume(v: number): void;
    setBass(b: number): void;
    setTreble(t: number): void;
    setMids(m: number): void;
    setCompressor(c: boolean): void;
    setNormalize(n: boolean): void;
    setKaraoke(enabled: boolean): void;
    startFade(targetVolume: number, durationMs: number): void;
    private canUpdate;
    private logChange;
}
//# sourceMappingURL=AudioEffectController.d.ts.map