import { Transform, Writable, Readable } from "stream";
import { AudioPlugin, AudioPluginBaseOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";
/**
 * FluentChain
 *
 * A wrapper for connecting several AudioPlugin (Transform streams) in sequence.
 *
 * @example <caption>Basic chaining and piping</caption>
 * import { Readable, Writable } from "stream";
 * import { FluentChain } from "./FluentChain";
 * import { PluginRegistry } from "./PluginRegistry";
 *
 * const myRegistry = new PluginRegistry();
 * // Assume plugins "gain" and "compressor" are registered in myRegistry
 * const pluginConfigs = [
 *   { name: "gain", options: { gain: 1.5 } },
 *   { name: "compressor", options: { threshold: -10 } }
 * ];
 * const defaultOptions = { sampleRate: 44100, channels: 2, bitDepth: 16 };
 *
 * const chain = new FluentChain(myRegistry, pluginConfigs, defaultOptions);
 * const source = Readable.from(* some audio data *);
 * const dest = new Writable({ write(chunk, enc, cb) { * ... * cb(); } });
 *
 * chain.pipe(source, dest);
 *
 * @example <caption>Get a Transform for integration with pipeline()</caption>
 * import { pipeline } from "stream";
 *
 * const transform = chain.getTransform();
 * pipeline(source, transform, dest, (err) => {
 *   if (err) {
 *     console.error("Pipeline error:", err);
 *   }
 * });
 */
export declare class FluentChain {
    private readonly registry;
    private readonly pluginConfigs;
    private readonly defaultOptions;
    private transforms;
    private controllers;
    /**
     * Constructs a new FluentChain.
     * @param registry - The plugin registry containing available plugins.
     * @param pluginConfigs - The ordered list of plugins to use and their options.
     * @param defaultOptions - The default options to apply to each plugin.
     */
    constructor(registry: PluginRegistry, pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>, defaultOptions: Required<AudioPluginBaseOptions>);
    /**
     * Initializes the chain of Transform streams based on plugin configuration.
     * Throws if a plugin is not found in the registry.
     */
    private buildChain;
    /**
     * Pipes the source Readable through all plugin transforms into the destination Writable.
     * Handles errors from any stream in the chain.
     *
     * @param source - The input Readable stream.
     * @param destination - The output Writable stream.
     * @example
     * chain.pipe(sourceStream, destStream);
     */
    pipe(source: Readable, destination: Writable): void;
    /**
     * Returns a single Transform stream representing the entire plugin chain.
     * Useful for embedding the whole chain as a single element in another pipeline.
     *
     * @returns {Transform} A transform that pipes data through all plugins.
     * @example
     * pipeline(source, chain.getTransform(), destination, cb);
     */
    getTransform(): Transform;
    /**
     * Returns plugin controller instances for parameter control.
     *
     * @returns {AudioPlugin[]} The plugin controller objects.
     * @example
     * const controllers = chain.getControllers();
     * controllers[0].setGain(2.0);
     */
    getControllers(): AudioPlugin[];
}
