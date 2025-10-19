import { EventEmitter } from "node:events";
import { Readable, Transform } from "node:stream";
import PluginRegistry from "./PluginRegistry.js";
import { type FFmpegRunResult, type ProcessorOptions, type AudioPluginBaseOptions, type AudioPlugin } from "../Types/index.js";
/**
 * Plugin configuration object or string identifier.
 */
export type PluginConfig = string | {
    name: string;
    options?: Partial<AudioPluginBaseOptions>;
};
/**
 * Encoder builder function signature.
 */
export type EncoderBuilder = (encoder: FluentStream) => void;
/**
 * FluentStream: main fluent API for building FFmpeg pipelines.
 * Supports plugins, advanced chains, and hot plugin swapping.
 *
 * @example
 * // Basic usage:
 * const fs = new FluentStream();
 * fs.input("input.mp3")
 *   .audioCodec("aac")
 *   .output("output.aac")
 *   .run();
 */
export default class FluentStream extends EventEmitter {
    static registry: PluginRegistry;
    static _globalRegistry: PluginRegistry | null;
    static HUMANITY_HEADER: {
        "X-Human-Intent": string;
        "X-Request-Attention": string;
        "User-Agent": string;
    };
    /**
     * Returns the global (singleton) plugin registry.
     *
     * @example
     * FluentStream.globalRegistry.register("myPlugin", myFactory);
     */
    static get globalRegistry(): PluginRegistry;
    /**
     * Registers a plugin globally for all FluentStream instances.
     *
     * @param name The plugin name.
     * @param factory Factory function returning a plugin instance.
     * @example
     * FluentStream.registerPlugin("custom", opts => new CustomPlugin(opts));
     */
    static registerPlugin<O extends AudioPluginBaseOptions>(name: string, factory: (options: Required<O>) => AudioPlugin<O>): void;
    /**
     * Checks if a plugin is registered in the global registry.
     *
     * @param name Plugin name.
     * @returns true if plugin exists.
     * @example
     * if (FluentStream.hasPlugin("loudnorm")) { ... }
     */
    static hasPlugin(name: string): boolean;
    /**
     * Clears all plugins from the global registry.
     * @example
     * FluentStream.clearPlugins();
     */
    static clearPlugins(): void;
    private args;
    private inputStreams;
    private complexFilters;
    readonly options: ProcessorOptions;
    private _headers;
    private audioTransform;
    private pluginHotSwap;
    private pcmOptions;
    private encoderBuilder;
    private pluginControllers;
    /**
     * Creates a new FluentStream instance.
     * @param options Optional processor options. You can specify a `headers` key to override default headers.
     *
     * @example
     * const fs = new FluentStream({ failFast: true });
     */
    constructor(options?: ProcessorOptions);
    /**
     * Sets custom HTTP headers to be used for the ffmpeg process.
     * Overrides any headers configured in constructor or set before.
     * If headers is undefined or null, default FluentStream.HUMANITY_HEADER will be used.
     *
     * @param headers Object with header fields, or undefined/null to use default.
     * @returns this
     * @example
     * fs.setHeaders({'Authorization': 'Bearer ...'})
     */
    setHeaders(headers?: Record<string, string> | null): this;
    /**
     * Returns the headers that will be used for the ffmpeg process.
     * Will return either custom, empty, or default headers.
     *
     * @returns A copy of the HTTP headers.
     * @example
     * const headers = fs.getHeaders();
     */
    getHeaders(): Record<string, string>;
    /**
     * Resets this FluentStream instance's state for re-use.
     * Keeps any custom headers.
     *
     * @example
     * fs.clear();
     */
    clear(): void;
    /**
     * Adds an input for the ffmpeg process. Supports file path or stream.
     * Must be called before plugins are used.
     *
     * @param input Input file path or readable stream.
     * @returns this
     * @example
     * fs.input("audio.mp3")
     *    .input(fs.createReadStream('track.wav'));
     */
    input(input: string | Readable): this;
    /**
     * Adds an output for the ffmpeg process.
     *
     * @param output Output file path, writable stream, numeric fd, or undefined/null for stdout.
     * @returns this
     * @example
     * fs.output("output.wav")
     * fs.output(1) // for stdout
     */
    output(output: string | Readable | number | undefined | null): this;
    /**
     * Adds global ffmpeg options (before all input/output).
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.globalOptions('-hide_banner', '-loglevel', 'error')
     */
    globalOptions(...opts: string[]): this;
    /**
     * Adds input options (must be before the last -i).
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.inputOptions('-ss', '5')
     */
    inputOptions(...opts: string[]): this;
    /**
     * Adds output options after all outputs.
     *
     * @param opts One or more ffmpeg arguments.
     * @returns this
     * @example
     * fs.outputOptions('-movflags', 'faststart')
     */
    outputOptions(...opts: string[]): this;
    /**
     * Sets the video codec to use.
     *
     * @param codec Video codec name.
     * @returns this
     * @example
     * fs.videoCodec('libx264')
     */
    videoCodec(codec: string): this;
    /**
     * Sets the audio codec to use.
     *
     * @param codec Audio codec name.
     * @returns this
     * @example
     * fs.audioCodec('aac')
     */
    audioCodec(codec: string): this;
    /**
     * Sets the video bitrate.
     *
     * @param bitrate Bitrate string, e.g., "1000k"
     * @returns this
     * @example
     * fs.videoBitrate('1200k')
     */
    videoBitrate(bitrate: string): this;
    /**
     * Sets the audio bitrate.
     *
     * @param bitrate Bitrate string, e.g., "192k"
     * @returns this
     * @example
     * fs.audioBitrate('192k')
     */
    audioBitrate(bitrate: string): this;
    /**
     * Sets the output format.
     *
     * @param format Format name, e.g. "mp3"
     * @returns this
     * @example
     * fs.format('flac')
     */
    format(format: string): this;
    /**
     * Sets a maximum duration (seconds or time string).
     *
     * @param time Duration (e.g. 120, "00:02:00")
     * @returns this
     * @example
     * fs.duration(60)
     */
    duration(time: string | number): this;
    /**
     * Disables video streams in the output.
     *
     * @returns this
     * @example
     * fs.noVideo()
     */
    noVideo(): this;
    /**
     * Disables audio streams in the output.
     *
     * @returns this
     * @example
     * fs.noAudio()
     */
    noAudio(): this;
    /**
     * Sets audio sample rate (frequency).
     *
     * @param freq Frequency e.g. 44100
     * @returns this
     * @example
     * fs.audioFrequency(48000)
     */
    audioFrequency(freq: number): this;
    /**
     * Sets number of audio channels.
     *
     * @param channels Number of channels e.g. 2
     * @returns this
     * @example
     * fs.audioChannels(2)
     */
    audioChannels(channels: number): this;
    /**
     * Use codec copy mode for all streams.
     *
     * @returns this
     * @example
     * fs.copyCodecs()
     */
    copyCodecs(): this;
    /**
     * Adds one or more complex filter graphs.
     *
     * @param graph String or array of filter graph strings.
     * @returns this
     * @example
     * fs.complexFilter('[0:a][1:a]acrossfade')
     */
    complexFilter(graph: string | string[]): this;
    /**
     * Adds audio crossfade (acrossfade filter) between two inputs.
     *
     * @param duration Crossfade duration (seconds)
     * @param opts Additional options
     * @returns this
     * @example
     * fs.input('a.mp3').input('b.mp3').crossfadeAudio(4)
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
     * Alias for usePlugins. Adds a single plugin and sets up plugin pipeline.
     *
     * @param buildEncoder Function that configures the final encoder.
     * @param pluginConfig Single plugin configuration.
     * @returns this
     * @example
     * fs.usePlugin(enc => enc.audioCodec('mp3'), "loudnorm")
     */
    usePlugin(buildEncoder: EncoderBuilder, pluginConfig: PluginConfig): this;
    /**
     * Adds one or more plugins and sets up the plugin pipeline. Enables transform chain.
     *
     * @param buildEncoder Function to configure the encoder instance (output).
     * @param pluginConfigs List of plugin configurations.
     * @returns this
     * @example
     * fs.usePlugins(enc => enc.audioCodec('aac'), "eq", {name:"loudnorm"})
     */
    usePlugins(buildEncoder: EncoderBuilder, ...pluginConfigs: PluginConfig[]): this;
    /**
     * Hot-swap plugin chain during processing.
     *
     * @param pluginConfigs New plugin configuration(s).
     * @returns Promise<void>
     * @example
     * await fs.updatePlugins("highpass", {name: "loudnorm"})
     */
    updatePlugins(...pluginConfigs: PluginConfig[]): Promise<void>;
    /**
     * Gets the current plugin controller instances.
     *
     * @returns Array of AudioPlugin controllers.
     * @example
     * const controllers = fs.getPluginControllers();
     */
    getPluginControllers(): AudioPlugin[];
    /**
     * Returns a copy of ffmpeg argument list that will be used.
     *
     * @returns Array of string arguments.
     * @example
     * console.log(fs.getArgs())
     */
    getArgs(): string[];
    private assembleArgs;
    /**
     * Used internally to merge user, default, and no headers logic.
     * If headers were set by setHeaders or in constructor, use them;
     * If not, use the default HUMANITY_HEADER.
     * If headers is empty object, use none.
     */
    private getMergedHeaders;
    private addHumanityHeadersToProcessorOptions;
    private createProcessor;
    private collectStreams;
    /**
     * Starts execution of the ffmpeg pipeline.
     * Selects plugin-based mode if plugins in use, else single process.
     *
     * @returns FFmpegRunResult object {output, done, stop}
     * @example
     * const { output, done } = fs.run();
     */
    run(): FFmpegRunResult;
    private runSingleProcess;
    private runWithPlugins;
    /**
     * Overwrites output files (-y flag).
     *
     * @returns this
     * @example
     * fs.overwrite()
     */
    overwrite(): this;
    /**
     * Adds a -map ffmpeg option to select specific streams.
     *
     * @param mapSpec Map specifier string.
     * @returns this
     * @example
     * fs.map('0:a:0')
     */
    map(mapSpec: string): this;
    /**
     * Seeks to a position in the input.
     *
     * @param position Time position (seconds or timestamp).
     * @returns this
     * @example
     * fs.seekInput(10)
     * fs.seekInput('00:01:00')
     */
    seekInput(position: number | string): this;
    /**
     * Gets the current audio transform pipeline (Transform stream).
     * Only available after usePlugins() was called.
     *
     * @returns Transform stream representing audio pipeline.
     * @throws Error if used before usePlugins()
     * @example
     * const transform = fs.getAudioTransform();
     */
    getAudioTransform(): Transform;
    /**
     * Gets the current plugin controllers (same as getPluginControllers).
     *
     * @returns Array of AudioPlugin controllers.
     * @example
     * fs.getControllers().forEach(ctrl => ...)
     */
    getControllers(): AudioPlugin[];
}
