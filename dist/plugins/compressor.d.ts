import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";
export interface CompressorPluginOptions extends AudioPluginBaseOptions {
    threshold: number;
    ratio: number;
}
/**
 * Simple dynamic range compressor.
 * Limits peaks above threshold.
 */
export declare class CompressorPlugin implements AudioPlugin<CompressorPluginOptions> {
    private options;
    constructor(options: CompressorPluginOptions);
    /** Динамически меняем настройки */
    setOptions(options: Partial<CompressorPluginOptions>): void;
    getOptions(): Required<CompressorPluginOptions>;
    createTransform(options: Required<CompressorPluginOptions>): Transform;
}
