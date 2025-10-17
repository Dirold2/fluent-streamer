import { Transform } from "stream";
export interface AudioPluginOptions {
    sampleRate?: number;
    channels?: number;
}
/**
 * AudioPlugin produces a Node Transform stream that processes PCM s16le audio.
 * It may also expose a small control API for runtime adjustments.
 */
export interface AudioPlugin {
    /** Create the transform implementing the plugin DSP */
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
/**
 * Simple gain plugin example: multiplies samples by a factor.
 */
export declare class GainPlugin implements AudioPlugin {
    private gain;
    constructor(gain: number);
    setGain(g: number): void;
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
