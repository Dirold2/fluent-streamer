import { Transform, Writable, Readable } from "stream";
import PluginRegistry from "./PluginRegistry.js";
import { AudioPlugin } from "fluent-streamer";
import { AudioPluginBaseOptions } from "../Types/index.js";
/**
 * Represents a chain of audio plugins, each implemented as a stream.Transform.
 * Provides utilities for assembling, updating, and connecting plugin pipelines.
 *
 * @template P AudioPlugin type (default: AudioPlugin)
 *
 * @example
 * // Example: Create a chain of plugins and pipe a stream through them
 * const registry = new PluginRegistry();
 * registry.register("gain", (opts) => new GainPlugin(opts));
 * registry.register("compressor", (opts) => new CompressorPlugin(opts));
 *
 * const chain = new FluentChain(
 *   registry,
 *   [
 *     { name: "gain", options: { gain: 1.5 } },
 *     { name: "compressor", options: { threshold: -10 } }
 *   ],
 *   { sampleRate: 44100, channels: 2 } // default options
 * );
 *
 * chain.pipe(fs.createReadStream('in.wav'), fs.createWriteStream('out.wav'));
 *
 * @example
 * // Example: Asynchronously build chain with plugins returning promises
 * await chain.buildChainAsync();
 */
export declare class FluentChain<P extends AudioPlugin = AudioPlugin> {
    private registry;
    private pluginConfigs;
    private defaultOptions;
    private transforms;
    private controllers;
    /**
     * Construct a FluentChain of plugins.
     * @param registry The PluginRegistry instance.
     * @param pluginConfigs Array of plugins to use in the chain, each with a name and optional options.
     * @param defaultOptions Default options applied to each plugin (overridden by pluginConfigs options).
     */
    constructor(registry: PluginRegistry, pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>, defaultOptions: Required<AudioPluginBaseOptions>);
    /**
     * Build/rebuild the plugin chain synchronously.
     * Throws if a plugin is missing or does not return a valid Transform.
     * For async plugins (e.g. using async createTransform), use buildChainAsync().
     * @private
     */
    private buildChain;
    /**
     * Asynchronously build/rebuild the plugin chain.
     * Used for plugins whose createTransform returns a Promise.
     *
     * @returns Promise<void>
     * @throws If a plugin is missing or does not return a valid Transform.
     *
     * @example
     * await chain.buildChainAsync();
     */
    buildChainAsync(): Promise<void>;
    /**
     * Update the plugin chain with a new list of plugin configurations.
     * Chain will be rebuilt synchronously.
     *
     * @param pluginConfigs Array of plugin descriptors { name, options }
     *
     * @example
     * chain.updatePlugins([
     *   { name: "normalize" },
     *   { name: "limiter", options: { threshold: -3 } }
     * ]);
     */
    updatePlugins(pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>): void;
    /**
     * Pipe a source stream through the plugin chain to a destination.
     * Any errors on transforms are forwarded to both source and destination.
     *
     * @param source Readable stream (input)
     * @param destination Writable stream (output)
     *
     * @example
     * chain.pipe(fs.createReadStream("input.wav"), fs.createWriteStream("output.wav"));
     */
    pipe(source: Readable, destination: Writable): void;
    /**
     * Get a duplex Transform for the entire plugin chain.
     * If no plugins, returns PassThrough; if one, returns its transform,
     * else wires all transforms together and wraps ends with a PassThrough.
     *
     * @returns Duplex Transform stream for use in piping (`.pipe(chain.getTransform()).pipe(...)`).
     *
     * @example
     * const duplex = chain.getTransform();
     * fs.createReadStream("input.wav").pipe(duplex).pipe(fs.createWriteStream("output.wav"));
     */
    getTransform(): Transform;
    /**
     * Get the instantiated plugin controllers in order.
     *
     * @returns Array of plugin instances (controllers)
     *
     * @example
     * const controllers = chain.getControllers();
     * controllers.forEach(ctrl => ctrl.setBypass(true));
     */
    getControllers(): P[];
}
