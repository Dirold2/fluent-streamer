import { EventEmitter } from "eventemitter3";
import { type Readable, Transform } from "stream";
import { type AudioPlugin, type AudioPluginBaseOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "../Types/index.js";
type EncoderBuilder = (encoder: FluentStream) => void;
/**
 * The FluentStream class provides a convenient, fluent API wrapper around a low-level `Processor` for working with FFmpeg.
 * Allows you to easily configure FFmpeg commands, manage inputs/outputs, and build advanced audio processing pipelines using plugins.
 * Supports building complex transcoding and media processing pipelines through chained methods, including handling user-defined audio plugins.
 *
 * @example <caption>Basic file conversion</caption>
 * const stream = new FluentStream()
 *   .input("input.mp3")
 *   .audioCodec("aac")
 *   .audioBitrate("192k")
 *   .output("output.aac");
 *
 * const { output, done } = stream.run();
 * output.pipe(fs.createWriteStream("output.aac"));
 * await done;
 *
 * @example <caption>Using audio effect plugins</caption>
 * // Register a custom plugin
 * FluentStream.registerPlugin("gain", opts => new GainPlugin(opts));
 *
 * // Using a registered plugin
 * const stream = new FluentStream()
 *   .input(fs.createReadStream("raw.wav"))
 *   .usePlugins(
 *     enc => enc.audioCodec("aac").output("final.m4a"),
 *     { name: "gain", options: { gainDb: 6 } }
 *   );
 *
 * const { output, done } = stream.run();
 * output.pipe(fs.createWriteStream("final.m4a"));
 * await done;
 *
 * @example <caption>Dynamically update plugins during processing</caption>
 * await stream.updatePlugins({ name: "compressor", options: { threshold: -20 } });
 *
 * @see run
 */
export declare class FluentStream extends EventEmitter {
    private static _globalRegistry;
    private static HUMANITY_HEADER;
    static get globalRegistry(): PluginRegistry;
    /**
     * Register a plugin for later use by name across all FluentStream instances.
     * @param name Plugin name.
     * @param factory Factory function to create a plugin instance given options.
     * @example
     * FluentStream.registerPlugin("normalize", opts => new NormalizePlugin(opts));
     */
    static registerPlugin<O extends AudioPluginBaseOptions>(name: string, factory: (options: Required<O>) => AudioPlugin<O>): void;
    /**
     * Check if a plugin is registered globally by name.
     * @param name Plugin name.
     * @returns true if the plugin is registered globally.
     */
    static hasPlugin(name: string): boolean;
    /**
     * Clear all globally registered plugins.
     */
    static clearPlugins(): void;
    private args;
    private inputStreams;
    private complexFilters;
    readonly options: SimpleFFmpegOptions;
    private audioTransform;
    private pluginHotSwap;
    private pcmOptions;
    private encoderBuilder;
    private _pluginControllers;
    /**
     * FluentStream constructor.
     * @param options Optional configuration for the FFmpeg/Processor.
     */
    constructor(options?: SimpleFFmpegOptions);
    getAudioTransform(): Transform;
    clear(): void;
    /**
     * Add an input file or stream to the FFmpeg command.
     * Multiple calls allowed for files (only one for streams).
     * Throws if called after .usePlugins().
     * @param input File path or a Readable stream.
     * @example
     * stream.input("input.mp3");
     * stream.input(fs.createReadStream("foo.wav"));
     */
    input(input: string | Readable): this;
    /**
     * Set the output file for FFmpeg.
     * @param output Output file path.
     * @example
     * stream.output("output.mp3")
     */
    output(output: string): this;
    /**
     * Add global FFmpeg options (before inputs).
     * @param opts Array of FFmpeg options (e.g. "-hide_banner", "-y").
     * @example
     * stream.globalOptions("-y", "-hide_banner");
     */
    globalOptions(...opts: string[]): this;
    /**
     * Add FFmpeg options for the last input.
     * @param opts Options for the corresponding input (e.g. "-ss", "30").
     * @example
     * stream.inputOptions("-ss", "10");
     */
    inputOptions(...opts: string[]): this;
    /**
     * Add FFmpeg output options.
     * @param opts Output options (e.g. "-map", "0:a").
     * @example
     * stream.outputOptions("-map", "0:a");
     */
    outputOptions(...opts: string[]): this;
    /**
     * Set the video codec.
     * Skips if codec is falsy/empty.
     * @param codec Codec name (e.g. "libx264").
     * @example
     * stream.videoCodec("libx264")
     */
    videoCodec(codec: string): this;
    /**
     * Set the audio codec.
     * Skips if codec is falsy/empty.
     * @param codec Audio codec name (e.g. "aac").
     * @example
     * stream.audioCodec("aac")
     */
    audioCodec(codec: string): this;
    /**
     * Set the video bitrate.
     * @param bitrate Bitrate string (e.g. "1M").
     * @example
     * stream.videoBitrate("1M")
     */
    videoBitrate(bitrate: string): this;
    /**
     * Set the audio bitrate.
     * @param bitrate Bitrate string (e.g. "192k").
     * @example
     * stream.audioBitrate("192k")
     */
    audioBitrate(bitrate: string): this;
    /**
     * Specify the output format for FFmpeg.
     * Calling multiple times replaces the previous format.
     * @param format Format string (e.g. "mp3").
     * @example
     * stream.format("mp3")
     */
    format(format: string): this;
    /**
     * Set the duration limit.
     * @param time Time in seconds or FFmpeg time string (e.g. "00:00:30").
     * @example
     * stream.duration(20)
     * stream.duration("00:01:10")
     */
    duration(time: string | number): this;
    /**
     * Disable video stream in the output.
     * @example
     * stream.noVideo()
     */
    noVideo(): this;
    /**
     * Disable audio stream in the output.
     * @example
     * stream.noAudio();
     */
    noAudio(): this;
    /**
     * Set the audio sample rate.
     * @param freq Sample rate (e.g. 44100)
     * @example
     * stream.audioFrequency(48000)
     */
    audioFrequency(freq: number): this;
    /**
     * Copy all codecs without transcoding.
     * Ensures only one "-c copy" is present.
     * @example
     * stream.copyCodecs()
     */
    copyCodecs(): this;
    /**
     * Allow overwriting the output file (-y).
     * @example
     * stream.overwrite()
     */
    overwrite(): this;
    /**
     * Use FFmpeg -map to map input streams to output.
     * @param label Map label string.
     * @example
     * stream.map("0:a:0")
     */
    map(label: string): this;
    /**
     * Seek to a specified input time using -ss.
     * @param time Time in seconds or FFmpeg time string.
     * @example
     * stream.seekInput(30)
     */
    seekInput(time: string | number): this;
    /**
     * Add a FFmpeg filter_complex graph to the pipeline.
     * Can be called multiple times.
     * Ignores empty strings.
     * @param graph Filter string or array of strings.
     * @example
     * stream.complexFilter("[0:a]loudnorm[aout]");
     */
    complexFilter(graph: string | string[]): this;
    /**
     * Adds an audio crossfade (acrossfade) filter between two audio streams to the filter_complex graph.
     * Throws if number of inputs is not exactly 2.
     * @param duration Duration in seconds.
     * @param options Optional channel labels.
     * @example
     * stream.crossfadeAudio(2.5, { inputA: '[0:a]', inputB: '[1:a]', outputLabel: 'acrossfaded' })
     */
    crossfadeAudio(duration: number, options?: {
        inputA?: string;
        inputB?: string;
        outputLabel?: string;
    }): this;
    /**
     * Alias for usePlugins for a single plugin.
     * @param buildEncoder Function that configures the output FluentStream encoder.
     * @param pluginConfig Plugin string or object with its options.
     * @example
     * stream.usePlugin(enc => enc.output("out.ogg"), "normalize");
     */
    usePlugin(buildEncoder: EncoderBuilder, pluginConfig: string | {
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }): this;
    /**
     * Switch the pipeline into plugin-processing mode.
     * Multiple plugins (chained) can be specified.
     * @param buildEncoder Function receiving a FluentStream for configuring the encoder (output process).
     * @param pluginConfigs One or more plugins: either a name string or an object { name, options }
     * @example
     * stream.input("in.wav").usePlugins(
     *   enc => enc.audioBitrate("192k").output("out.ogg"),
     *   "normalize", { name: "compressor" }
     * );
     */
    usePlugins(buildEncoder: EncoderBuilder, ...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>): this;
    /**
     * Returns the plugin controllers, for usePlugins-style interface.
     * When called as a property on the result of usePlugins, is bound.
     */
    getControllers(): AudioPlugin[];
    /**
     * Hot-swap (update) the plugin chain at runtime without stopping the pipeline.
     * ONLY after calling usePlugins().
     * @param pluginConfigs New configuration(s) for plugin(s).
     * @example
     * await stream.updatePlugins("compressor", { name: "custom", options: {...} });
     */
    updatePlugins(...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>): Promise<void>;
    /**
     * Get the array of plugin controller instances currently in use.
     * @returns An array of AudioPlugin instances.
     */
    getPluginControllers(): AudioPlugin[];
    /**
     * Run the constructed FFmpeg pipeline.
     * If plugins are used: spawns both a decoder, plugin-processing chain, and encoder (dual process).
     * Returns an object with output Readable stream, a done promise, and a stop function.
     *
     * @example
     * const { output, done, stop } = stream.run();
     * output.pipe(fs.createWriteStream("foo.ogg"));
     * await done;
     */
    run(): FFmpegRunResult;
    /**
     * Get the current array of arguments for the ffmpeg process.
     * @returns FFmpeg argument array.
     * @example
     * const args = stream.getArgs();
     */
    getArgs(): string[];
    private assembleArgs;
    private addHumanityHeadersToProcessorOptions;
    private runSingleProcess;
    private runWithPlugins;
    private setupProcessorEvents;
}
export { FluentStream as default };
