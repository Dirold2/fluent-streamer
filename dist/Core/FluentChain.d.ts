import { Transform, Writable } from "stream";
import { AudioPluginOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";
/**
 * FluentChain
 *
 * Wrapper around multiple AudioPlugins that allows piping sequentially.
 */
export declare class FluentChain {
    private registry;
    private pluginConfigs;
    private defaultOptions;
    private transforms;
    constructor(registry: PluginRegistry, pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginOptions>;
    }>, defaultOptions: Required<AudioPluginOptions>);
    /**
     * Build Transform streams from plugin names and options.
     */
    private buildChain;
    /**
     * Pipe a source stream into the chain and then to a destination.
     */
    pipeTo(destination: Writable): void;
    /**
     * Get a single Transform stream representing the whole chain.
     */
    getTransform(): Transform;
}
