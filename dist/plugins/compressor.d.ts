import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";
/**
 * Simple dynamic range compressor.
 * Limits peaks above threshold.
 */
export declare class CompressorPlugin implements AudioPlugin {
    private threshold;
    private ratio;
    constructor(threshold?: number, ratio?: number);
    setParams(threshold: number, ratio: number): void;
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
