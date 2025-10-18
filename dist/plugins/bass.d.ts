import { AudioPlugin, AudioPluginBaseOptions } from "../../src/Core";
import { Transform } from "stream";
export interface BassPluginOptions extends AudioPluginBaseOptions {
    bass: number;
}
/**
 * Bass boost plugin.
 * Усиление басов на PCM аудио.
 */
export declare class BassPlugin implements AudioPlugin<BassPluginOptions> {
    private options;
    constructor(options: BassPluginOptions);
    /** Динамически меняем настройки */
    setOptions(options: Partial<BassPluginOptions>): void;
    getOptions(): Required<BassPluginOptions>;
    createTransform(options?: Required<BassPluginOptions>): Transform;
}
