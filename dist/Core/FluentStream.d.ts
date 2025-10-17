/**
 * @class FluentStream
 * @classdesc
 * FluentStream is a fluent, chainable wrapper around the low-level Processor for building FFmpeg command arguments and optionally attaching input streams.
 *
 * Provides an ergonomic builder API for constructing FFmpeg commands,
 * attaching file or stream inputs, and customizing options including JS audio transforms.
 *
 * @example
 * // Basic usage with file input and output:
 * const ff = new FluentStream({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('output.mp4');
 * const { output, done } = ff.run();
 *
 * @example
 * // With stream input/output and custom filter
 * const ff = new FluentStream()
 *   .input(someReadableStream)
 *   .outputOptions('-preset', 'fast')
 *   .complexFilter('[0:v]scale=320:240[vout]')
 *   .map('[vout]')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 *
 * @example
 * // Using JS audio transform (node stream as PCM)
 * ff
 *   .input('song.mp3')
 *   .withAudioTransform(myTransform, (enc) => enc.audioCodec('aac').output('song-processed.aac'));
 * ff.run();
 */
import { EventEmitter } from "eventemitter3";
import { type Readable, Transform } from "stream";
import { type AudioPlugin, type AudioPluginOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "../Types/index.js";
/**
 * @class SimpleFFmpeg
 * @classdesc
 * SimpleFFmpeg provides a convenient, chainable interface for constructing FFmpeg commands. It delegates execution to the low-level Processor.
 *
 * @example
 * const ff = new SimpleFFmpeg({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 */
export declare class FluentStream extends EventEmitter {
    private static _globalRegistry;
    /** Get or create the global plugin registry singleton */
    private static get globalRegistry();
    /** Register a plugin globally (preferred API surface) */
    static registerPlugin(name: string, factory: (options: Required<AudioPluginOptions>) => AudioPlugin): void;
    /** Check if a plugin is registered globally */
    static hasPlugin(name: string): boolean;
    /** Clear global plugins (intended for tests) */
    static clearPlugins(): void;
    private args;
    private inputStreams;
    private inputFiles;
    private readonly options;
    private pendingFifos;
    audioTransformConfig?: {
        transform: Transform;
        sampleRate: number;
        channels: number;
        buildEncoder: (enc: FluentStream) => void;
    };
    private audioPluginConfig?;
    /**
     * Create a new FluentStream builder.
     *
     * @param {SimpleFFmpegOptions} [options] - Default configuration for the created Processor.
     *
     * @example
     * const ff = new FluentStream({ enableProgressTracking: true });
     */
    constructor(options?: SimpleFFmpegOptions);
    /**
     * Set global FFmpeg options (prepended to command).
     * @param {...string} opts
     * @returns {FluentStream}
     */
    globalOptions(...opts: string[]): FluentStream;
    /**
     * Set input options (inserted before last input).
     * @param {...string} opts
     * @returns {FluentStream}
     */
    inputOptions(...opts: string[]): FluentStream;
    /**
     * Add an input (filename or Readable stream).
     * @param {string|Readable} input
     * @returns {FluentStream}
     */
    input(input: string | Readable): FluentStream;
    /**
     * Add a named pipe FIFO as input.
     * @param {string} fifoPath
     * @returns {FluentStream}
     */
    inputFifo(fifoPath: string): FluentStream;
    /**
     * Generate a new FIFO path in a temp directory and add as an input.
     * @param {{dir?: string, prefix?: string}} [options]
     * @returns {string} Absolute FIFO path
     */
    prepareNextTrackFifo(options?: {
        dir?: string;
        prefix?: string;
    }): string;
    /**
     * Set output destination (filename, 'pipe:1', etc.).
     * @param {string} output
     * @returns {FluentStream}
     */
    output(output: string): FluentStream;
    /**
     * Add options for output.
     * @param {...string} opts
     * @returns {FluentStream}
     */
    outputOptions(...opts: string[]): FluentStream;
    /**
     * Specify video codec.
     * @param {string} codec
     * @returns {FluentStream}
     */
    videoCodec(codec: string): FluentStream;
    /**
     * Specify audio codec.
     * @param {string} codec
     * @returns {FluentStream}
     */
    audioCodec(codec: string): FluentStream;
    /**
     * Set video bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     */
    videoBitrate(bitrate: string): FluentStream;
    /**
     * Set audio bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     */
    audioBitrate(bitrate: string): FluentStream;
    /**
     * Set output video size.
     * @param {string} size
     * @returns {FluentStream}
     */
    size(size: string): FluentStream;
    /**
     * Set framerate.
     * @param {number} fps
     * @returns {FluentStream}
     */
    fps(fps: number): FluentStream;
    /**
     * Set output duration.
     * @param {string|number} duration
     * @returns {FluentStream}
     */
    duration(duration: string | number): FluentStream;
    /**
     * Set input seek time.
     * @param {string|number} time
     * @returns {FluentStream}
     */
    seek(time: string | number): FluentStream;
    /**
     * Set output format.
     * @param {string} format
     * @returns {FluentStream}
     */
    format(format: string): FluentStream;
    /**
     * Enable overwrite output files.
     * @returns {FluentStream}
     */
    overwrite(): FluentStream;
    /**
     * Disable overwrite output files.
     * @returns {FluentStream}
     */
    noOverwrite(): FluentStream;
    /**
     * Add a complex filtergraph.
     * @param {string} filterGraph
     * @returns {FluentStream}
     */
    complexFilter(filterGraph: string): FluentStream;
    /**
     * Select FFmpeg output stream label.
     * @param {string} label
     * @returns {FluentStream}
     */
    map(label: string): FluentStream;
    /**
     * Add an audio crossfade filter. Output is mapped to '[aout]'.
     * @param {number} durationSeconds
     * @param {{inputA?: number, inputB?: number, curve1?: string, curve2?: string}} [options]
     * @returns {FluentStream}
     */
    crossfadeAudio(durationSeconds: number, options?: {
        inputA?: number;
        inputB?: number;
        curve1?: string;
        curve2?: string;
    }): FluentStream;
    /**
     * Attach a JS Transform stream to process PCM data between decode and encode. Only one FFmpeg process is spawned with transform inserted in the chain.
     *
     * @param {Transform} transform - Node.js transform stream
     * @param {function(FluentStream):void} buildEncoder - Callback to set codecs/output after transform
     * @param {{sampleRate?: number, channels?: number}} [opts] - Audio stream settings
     * @returns {FluentStream}
     */
    withAudioTransform(transform: Transform, buildEncoder: (enc: FluentStream) => void, opts?: {
        sampleRate?: number;
        channels?: number;
    }): FluentStream;
    /**
     * Use an AudioPlugin (see Filters.js) to insert a JS transform in the PCM chain. buildEncoder lets you configure target encoding/output after processing.
     * @param {AudioPlugin} plugin
     * @param {function(FluentStream):void} buildEncoder
     * @param {AudioPluginOptions} [opts]
     * @returns {FluentStream}
     */
    withAudioPlugin(plugin: AudioPlugin, buildEncoder: (enc: FluentStream) => void, opts?: AudioPluginOptions): FluentStream;
    /**
     * Build and attach a chain of audio plugins via registry.
     * Creates a composed Transform and delegates to withAudioTransform.
     */
    withAudioPlugins(registry: PluginRegistry, ...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginOptions>;
    }>): FluentStream;
    /**
     * Preferable helper: use globally registered plugins by name.
     * Equivalent to withAudioPlugins(FluentStream.globalRegistry, ...configs)
     */
    usePlugins(...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginOptions>;
    }>): FluentStream;
    /** Shortcut for a single plugin by name with optional options */
    usePlugin(name: string, options?: Partial<AudioPluginOptions>): FluentStream;
    /**
     * Execute the FFmpeg command. All processor events are re-emitted.
     * @param {{ffplay?: boolean, [key: string]: any}} [opts]
     * @returns {FFmpegRunResult}
     */
    run(opts?: {
        ffplay?: boolean;
        [key: string]: any;
    }): FFmpegRunResult;
    /**
     * Get current FFmpeg arguments.
     * @returns {string[]}
     */
    getArgs(): string[];
    /**
     * Get a string representation of the full FFmpeg command.
     * @returns {string}
     */
    toString(): string;
    /**
     * Get all configured input streams.
     * @returns {Array<{stream: Readable, index: number}>}
     */
    getInputStreams(): Array<{
        stream: Readable;
        index: number;
    }>;
    /**
     * Ensure that a FIFO file exists, creating it synchronously if needed.
     * Throws if existing path is not a FIFO.
     * @param {string} filePath
     * @private
     */
    private ensureFifoSync;
}
export { FluentStream as default };
