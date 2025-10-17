import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";
/**
 * Volume fade plugin.
 * Smoothly interpolates volume over frames.
 */
export declare class VolumeFaderPlugin implements AudioPlugin {
    private start;
    private end;
    constructor(start?: number, end?: number);
    setFade(start: number, end: number): void;
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
