import { EventEmitter } from "eventemitter3";
import { Readable, Transform } from "node:stream";
import PluginRegistry from "./PluginRegistry.js";
import { type FFmpegRunResult, type ProcessorOptions, type AudioPluginBaseOptions, type AudioPlugin } from "../Types/index.js";
/**
 * Represents the plugin configuration which can be a string (plugin name)
 * or an object with name and options.
 */
export type PluginConfig = string | {
    name: string;
    options?: Partial<AudioPluginBaseOptions>;
};
/**
 * Signature for a function that receives an encoder for configuring audio plugins.
 */
export type EncoderBuilder = (encoder: FluentStream) => void;
/**
 * FluentStream provides a fluent, strongly-typed API for constructing and running FFmpeg processes.
 * It supports plugins, filter chains, transform streams, and advanced process configuration.
 *
 * See examples below.
 *
 * @example
 * // Simple audio conversion
 * const proc = new FluentStream()
 *   .input('song.mp3')
 *   .audioCodec('aac')
 *   .output('song.aac')
 *   .run();
 *
 * @example
 * // Use global plugins with plugin chain and custom headers
 * FluentStream.registerPlugin('myPlugin', opts => new MyPlugin(opts));
 *
 * const pipeline = new FluentStream({ enableProgressTracking: true })
 *   .setHeaders({ Authorization: 'Bearer abc123' })
 *   .input('input.wav')
 *   .usePlugins(
 *     enc => enc.audioCodec('aac').output('output.m4a'),
 *     "myPlugin",
 *     { name: "normalize", options: { level: 0.95 } }
 *   )
 *   .run();
 *
 * @example
 * // With custom filter and progress
 * const res = new FluentStream()
 *   .input('in.mp3')
 *   .complexFilter('volume=2')
 *   .output('out.mp3')
 *   .run();
 * res.process.on('progress', prog => console.log(prog));
 */
export default class FluentStream extends EventEmitter {
    static registry: PluginRegistry;
    static _globalRegistry: PluginRegistry | null;
    static HUMANITY_HEADER: Readonly<{
        "X-Human-Intent": "true";
        "X-Request-Attention": "just-want-to-do-my-best";
        "User-Agent": "FluentStream/1.0 (friendly bot)";
    }>;
    /**
     * Forcibly clears all global plugins and plugin state (TESTING ONLY).
     * This is a test helper to reset plugin registries between tests.
     */
    static _reset(): void;
    /**
     * Retrieve the global plugin registry.
     */
    static get globalRegistry(): PluginRegistry;
    /**
     * Register a new global audio plugin.
     * @param name - Name of the plugin.
     * @param factory - Factory function producing the plugin.
     * @template O Plugin options type.
     */
    static registerPlugin<O extends AudioPluginBaseOptions>(name: string, factory: (options: Required<O>) => AudioPlugin<O>): void;
    /**
     * Checks if a plugin is registered globally.
     * @param name - Plugin name.
     */
    static hasPlugin(name: string): boolean;
    /**
     * List all registered global plugins.
     */
    static listPlugins(): string[];
    /**
     * Unregister (remove) a global plugin by name.
     * @param name - Plugin name to remove.
     * @returns true if the plugin was removed, false otherwise.
     */
    static unregisterPlugin(name: string): boolean;
    /**
     * Clears all global plugins. Useful in testing.
     */
    static clearPlugins(): void;
    private args;
    private inputStreams;
    private complexFilters;
    readonly options: ProcessorOptions;
    _headers: Record<string, string> | undefined;
    private audioTransform;
    private pluginHotSwap;
    private encoderBuilder;
    private pluginControllers;
    /**
     * Creates a new FluentStream instance.
     * @param options - Optional processor options.
     */
    constructor(options?: ProcessorOptions);
    /**
     * Set HTTP headers (overwrites previous). Null or undefined disables.
     * @param headers - Headers to set.
     */
    setHeaders(headers?: Record<string, string> | null): this;
    /**
     * Get HTTP headers (or HUMANITY_HEADER if unset).
     */
    getHeaders(): Record<string, string>;
    /**
     * Add or replace the `-headers` argument for FFmpeg.
     * Escapes semicolons as \; per ffmpeg command line requirements.
     * @param headers - Custom headers.
     * @returns this
     */
    headers(headers?: Record<string, string> | null): this;
    /**
     * Add or replace the `-user_agent` argument for an input file.
     * @param userAgent - HTTP User-Agent string.
     */
    userAgent(userAgent?: string | null): this;
    /**
     * Reset all FFmpeg args, plugin/pipeline settings, and filters.
     */
    clear(): void;
    /**
     * Add an input (string/file or Readable stream).
     * Streams are supported as only one input.
     * @param input - Input filename or Readable stream.
     */
    input(input: string | Readable): this;
    /**
     * Add an output (filename, stream, or descriptor).
     * @param output - Output target.
     */
    output(output: string | Readable | number | undefined | null): this;
    /**
     * Add global FFmpeg options (placed before first `-i`).
     * @param opts - Option strings.
     */
    globalOptions(...opts: string[]): this;
    /**
     * Add options before the last input.
     * @param opts - Option strings.
     */
    inputOptions(...opts: string[]): this;
    /**
     * Add options to the end, after outputs.
     * @param opts - Option strings.
     */
    outputOptions(...opts: string[]): this;
    /**
     * Set video codec (adds `-c:v codec` if codec is truthy).
     * @param codec - Video codec name.
     */
    videoCodec(codec: string): this;
    /**
     * Set audio codec (adds `-c:a codec` if codec is truthy).
     * @param codec - Audio codec name.
     */
    audioCodec(codec: string): this;
    /**
     * Set video bitrate.
     * @param bitrate - Bitrate (e.g. '800k').
     */
    videoBitrate(bitrate: string): this;
    /**
     * Set audio bitrate.
     * @param bitrate - Bitrate (e.g. '192k').
     */
    audioBitrate(bitrate: string): this;
    /**
     * Set output format (adds or replaces `-f`).
     * @param format - Format name (e.g. 'mp3').
     */
    format(format: string): this;
    /**
     * Limit FFmpeg run time duration (seconds or formatted string).
     * @param time - Duration to pass to FFmpeg's `-t`.
     */
    duration(time: string | number): this;
    /**
     * Disable all video streams (`-vn`).
     */
    noVideo(): this;
    /**
     * Disable all audio streams (`-an`).
     */
    noAudio(): this;
    /**
     * Set audio sampling frequency (`-ar`).
     * @param freq - Frequency in Hz.
     */
    audioFrequency(freq: number): this;
    /**
     * Set number of audio channels (`-ac`).
     * @param channels - Channel count (e.g. 1 for mono).
     */
    audioChannels(channels: number): this;
    /**
     * Copy all codecs for all streams (`-c copy`).
     */
    copyCodecs(): this;
    /**
     * Add a complex filter specification (or array thereof).
     * @param graph - Filter string or array.
     */
    complexFilter(graph: string | string[]): this;
    /**
     * Quickly cross-fade two audio inputs using `acrossfade` filter.
     * @param duration - Crossfade duration in seconds.
     * @param opts - Additional acrossfade options.
     * @throws if less than 2 inputs are present.
     */
    crossfadeAudio(duration: number, opts?: {
        c1?: string;
        c2?: string;
        curve1?: string;
        curve2?: string;
        additional?: string;
        input2?: string | Readable;
        nb_samples?: number;
        overlap?: boolean;
        inputLabels?: string[];
        outputLabel?: string;
        inputs?: number;
    }): this;
    /**
     * Use a single plugin (shortcut for usePlugins).
     * @param buildEncoder - Function to configure the encoder.
     * @param pluginConfig - Plugin config.
     */
    usePlugin(buildEncoder: EncoderBuilder, pluginConfig: PluginConfig): this;
    /**
     * Use a chain of audio plugins - chainable.
     * The `buildEncoder` callback is used for final configuration just before running.
     * @param buildEncoder - Receives encoder instance for final setup.
     * @param pluginConfigs - One or more plugin configs to apply in order.
     * @throws if no plugin configs are passed.
     * @returns this
     */
    usePlugins(buildEncoder: EncoderBuilder, ...pluginConfigs: PluginConfig[]): this;
    /**
     * Replace the current audio plugin chain at runtime.
     * Safe hot-swap.
     * @param pluginConfigs - Plugin configs to apply.
     * @throws if called before `.usePlugins()`
     */
    updatePlugins(...pluginConfigs: PluginConfig[]): Promise<void>;
    /**
     * Retrieve a plugin controller instance by its name, if present.
     * @param name - The registered plugin name.
     * @returns The AudioPlugin instance for the given name, or undefined.
     */
    getPlugin(name: string): AudioPlugin | undefined;
    /**
     * List all currently active plugins, returning their { name, options? }.
     * Does NOT expose controller internals.
     * @returns Array of { name, options? }
     */
    getPlugins(): Array<{
        name: string;
        options?: any;
    }>;
    /**
     * Get current plugin state for a specific plugin, or for all plugins if name omitted.
     * If a plugin exposes .getState(), returns result; else returns undefined.
     *
     * @param name - Optional plugin name. If present, returns only that plugin's state.
     * @returns State object of the named plugin, or map of all plugin states if name omitted.
     */
    getPluginState(name?: string): any;
    /**
     * Access the array of plugin controller instances (internal representation).
     * For advanced usage only.
     */
    getPluginControllers(): AudioPlugin[];
    /**
     * Get a snapshot (copy) of the current FFmpeg argument array.
     */
    getArgs(): string[];
    /**
     * Assembles final set of FFmpeg arguments considering added filters, global options, etc.
     */
    private assembleArgs;
    /**
     * Get headers merged with HUMANITY_HEADER defaults.
     * @private
     */
    private getMergedHeaders;
    /**
     * Merge supplied options with headers from getMergedHeaders.
     * @private
     */
    private addHumanityHeadersToProcessorOptions;
    /**
     * Build a Processor instance, optionally overriding arguments and input streams.
     * @private
     */
    private createProcessor;
    /**
     * Run the FFmpeg process, building up plugins/filter args and options as needed.
     * Returns an object with the process and control helpers.
     *
     * @returns {FFmpegRunResult}
     */
    run(): FFmpegRunResult;
    /**
     * Allow file overwrite (`-y`).
     */
    overwrite(): this;
    /**
     * Add a custom `-map` spec (for selecting streams).
     * @param mapSpec - FFmpeg stream map string.
     */
    map(mapSpec: string): this;
    /**
     * Seek input (using `-ss`) before first `-i`.
     * @param position - Time to seek to.
     */
    seekInput(position: number | string): this;
    /**
     * Get current audio transform pipeline (as a Transform).
     * Only available after usePlugins().
     * @throws if not called after usePlugins().
     */
    getAudioTransform(): Transform;
    /**
     * Alias for getPluginControllers().
     */
    getControllers(): AudioPlugin[];
}
