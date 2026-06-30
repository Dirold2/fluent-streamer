import type { AudioProcessingOptions, FFmpegRunResultExtended } from "../Types/index.js";
export declare class FluentAudioState {
    enabled: boolean;
    volume: number;
    bass: number;
    treble: number;
    compressor: boolean;
    private result;
    private sampleRate?;
    private channels?;
    private cachedOptions;
    private cachedHash;
    constructor(config?: {
        volume?: number;
        bass?: number;
        treble?: number;
        compressor?: boolean;
        enabled?: boolean;
        sampleRate?: number;
        channels?: number;
    });
    /** Attach a live processor result — all setters will bridge through it. */
    attachResult(result: FFmpegRunResultExtended | null): void;
    setVolume(v: number): this;
    setBass(v: number): this;
    setTreble(v: number): this;
    setCompressor(v: boolean): this;
    enable(enable: boolean): this;
    startFade(targetVolume: number, durationMs: number): this;
    fadeIn(targetVolume?: number, durationMs?: number): this;
    fadeOut(durationMs?: number): this;
    changeVolume(v: number): boolean;
    changeBass(v: number): boolean;
    changeTreble(v: number): boolean;
    changeCompressor(v: boolean): boolean;
    changeNormalize(v: boolean): boolean;
    buildOptions(sampleRate?: number, channels?: number): AudioProcessingOptions;
    debugInfo(): {
        volume: number;
        bass: number;
        treble: number;
        compressor: boolean;
        enabled: boolean;
    };
}
//# sourceMappingURL=FluentAudioState.d.ts.map