import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";
/**
 * Simple gain plugin example.
 * Multiplies each audio sample by a gain factor.
 */
export declare class GainPlugin implements AudioPlugin {
    private gain;
    constructor(gain: number);
    /**
     * Sets the gain factor.
     * @param g - Gain multiplier
     */
    setGain(g: number): void;
    /**
     * Creates a Node.js Transform stream that applies the gain to PCM s16le audio.
     * @param options - Audio options (sampleRate, channels)
     * @returns Transform stream that processes audio
     */
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
