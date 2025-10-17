import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";
/**
 * Bass boost plugin.
 * Simple IIR-style bass boost on stereo PCM audio.
 */
export declare class BassPlugin implements AudioPlugin {
    private bass;
    constructor(bass: number);
    setBass(b: number): void;
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
