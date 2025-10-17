import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";
export declare class TreblePlugin implements AudioPlugin {
    private treble;
    constructor(treble: number);
    setTreble(t: number): void;
    createTransform(options: Required<AudioPluginOptions>): Transform;
}
