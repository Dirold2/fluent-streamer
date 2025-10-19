import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";
export interface GainPluginOptions extends AudioPluginBaseOptions {
    gain: number;
}
/**
 * Simple gain plugin example.
 * Multiplies each audio sample by a gain factor.
 */
export declare class GainPlugin implements AudioPlugin<GainPluginOptions> {
    private options;
    constructor(options: GainPluginOptions);
    setOptions(options: Partial<GainPluginOptions>): void;
    getOptions(): Required<GainPluginOptions>;
    /**
     * Creates a Node.js Transform stream that applies the gain to PCM s16le audio.
     * @param options - Audio options (sampleRate, channels)
     * @returns Transform stream that processes audio
     */
    createTransform(options: Required<GainPluginOptions>): Transform;
}
