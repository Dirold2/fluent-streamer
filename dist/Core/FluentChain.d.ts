import { Transform, Writable, Readable } from "stream";
import PluginRegistry from "./PluginRegistry.js";
import { AudioPlugin } from "fluent-streamer";
import { AudioPluginBaseOptions } from "../Types/index.js";
/**
 * FluentChain
 *
 * Class for sequentially chaining multiple audio plugins as Transform streams.
 *
 * Features:
 * - Correct error handling, propagating errors to source and destination
 * - Safe chaining using pipeline()
 * - Dynamic chain updating via updatePlugins()
 * - Strong typing through generics (for plugin-specific usage)
 * - Optional async support for createTransform
 *
 * @template P Type of plugins used (for stricter typing)
 *
 * @example <caption>Basic chaining with Buffers</caption>
 * ```ts
 * import { Readable, Writable } from "stream";
 * import { FluentChain } from "./FluentChain";
 * import PluginRegistry from "./PluginRegistry";
 *
 * const myRegistry = new PluginRegistry();
 * // Register plugins "gain", "compressor"
 * // ...
 * const chain = new FluentChain(myRegistry, [
 *   { name: "gain", options: { gain: 1.5 } },
 *   { name: "compressor", options: { threshold: -10 } }
 * ], { sampleRate: 48000, channels: 2, bitDepth: 16 });
 *
 * const source = Readable.from(Buffer.from([* ... PCM samples ... *]));
 * const dest = new Writable({ write(chunk, enc, cb) { * ... * cb(); } });
 * chain.pipe(source, dest);
 * ```
 *
 * @example <caption>Multi-input (Split streams)</caption>
 * For advanced use, implement fan-in/fan-out manually by piping to multiple chains:
 * ```ts
 * // See chain.pipe() signature for inspiration;
 * // You can create multiple chains and send data to each as needed.
 * ```
 *
 * @example <caption>As a Transform for pipeline()</caption>
 * ```ts
 * import { pipeline } from "stream";
 * pipeline(source, chain.getTransform(), destination, err => { ... });
 * ```
 */
export declare class FluentChain<P extends AudioPlugin = AudioPlugin> {
    private registry;
    private pluginConfigs;
    private defaultOptions;
    private transforms;
    private controllers;
    /**
     * Create a new plugin chain.
     * @param registry Plugin registry with available plugins
     * @param pluginConfigs Array of { name, options }
     * @param defaultOptions Default options for all plugins in the chain
     */
    constructor(registry: PluginRegistry, pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>, defaultOptions: Required<AudioPluginBaseOptions>);
    /**
     * Create or rebuild the plugin chain.
     * Supports both sync and async createTransform functions.
     * If any plugin uses an async createTransform, use buildChainAsync() instead.
     * @private
     */
    private buildChain;
    /**
     * Asynchronously build (or rebuild) the plugin chain.
     * Call this if you know your plugins use async createTransform methods.
     *
     * @returns {Promise<void>}
     *
     * @example
     * ```ts
     * await chain.buildChainAsync();
     * ```
     */
    buildChainAsync(): Promise<void>;
    /**
     * Update the plugin chain with a new set of plugins and/or options without recreating the FluentChain instance.
     *
     * @param pluginConfigs New array of {name, options}
     *
     * @example
     * ```ts
     * chain.updatePlugins([
     *   { name: "newPlugin", options: { ... } },
     *   { name: "anotherPlugin" }
     * ]);
     * ```
     */
    updatePlugins(pluginConfigs: Array<{
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>): void;
    /**
     * Pipe through the entire plugin chain, connecting source → ...transforms... → destination.
     *
     * - All transform errors are propagated to both source and destination.
     * - The pipeline is safely closed on error.
     *
     * @param source {Readable} The source readable stream (e.g., Readable.from(Buffer))
     * @param destination {Writable} Any writable stream (stdout, File, PassThrough, etc.)
     *
     * @example
     * ```ts
     * const chain = new FluentChain(...);
     * chain.pipe(
     *   Readable.from(Buffer.from([* PCM data *])),
     *   fs.createWriteStream("out.raw")
     * );
     * ```
     */
    pipe(source: Readable, destination: Writable): void;
    /**
     * Get a single consolidated Transform stream for the entire chain.
     *
     * - Use chain.getTransform() in a pipeline, and data piped in will be processed sequentially through all plugins.
     * - Returns a PassThrough if there are no plugins; returns the first plugin's transform if there's only one.
     *
     * All plugin errors are re-emitted on the returned Transform.
     *
     * @returns {Transform} A transform stream combining all plugins.
     *
     * @example
     * ```ts
     * import { pipeline } from "stream";
     * pipeline(
     *   Readable.from(Int16Array),
     *   chain.getTransform(),
     *   fs.createWriteStream("output.raw"),
     *   err => { if (err) console.error(err); }
     * );
     * ```
     */
    getTransform(): Transform;
    /**
     * Get the array of plugin controller instances.
     * Use this for runtime parameter change, plugin introspection, etc.
     *
     * @returns {P[]} Array of plugin controller instances.
     *
     * @example
     * ```ts
     * const controllers = chain.getControllers();
     * controllers[0].setGain?.(2.0);
     * ```
     */
    getControllers(): P[];
}
