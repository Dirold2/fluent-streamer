import { AudioPlugin, AudioPluginBaseOptions } from "../../src/Core";
import { Transform } from "stream";
export interface VolumePluginOptions extends AudioPluginBaseOptions {
    start: number;
    end: number;
}
/**
 * Volume fade plugin.
 * Smoothly interpolates volume over frames.
 */
export declare class VolumeFaderPlugin implements AudioPlugin {
    private options;
    constructor(options: VolumePluginOptions);
    setOptions(options: Partial<VolumePluginOptions>): void;
    getOptions(): Required<VolumePluginOptions>;
    createTransform(options: Required<VolumePluginOptions>): Transform;
}
