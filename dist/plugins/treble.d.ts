import { AudioPlugin, AudioPluginBaseOptions } from "src/Core";
import { Transform } from "stream";
export interface TreblePluginOptions extends AudioPluginBaseOptions {
    treble: number;
}
export declare class TreblePlugin implements AudioPlugin<TreblePluginOptions> {
    private options;
    constructor(options: TreblePluginOptions);
    setOptions(options: Partial<TreblePluginOptions>): void;
    getOptions(): Required<TreblePluginOptions>;
    createTransform(options: Required<TreblePluginOptions>): Transform;
}
