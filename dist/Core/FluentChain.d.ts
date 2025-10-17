import { Transform, Writable, Readable } from "stream";
import { AudioPlugin, AudioPluginOptions } from "./Filters.js";
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
    private controllers;
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
    pipe(source: Readable, destination: Writable): void;
    /**
     * Get a single Transform stream representing the whole chain.
     */
    getTransform(): Transform;
    /**
     * Return controller instances (plugin objects) to allow hot parameter updates
     */
    getControllers(): AudioPlugin[];
}
