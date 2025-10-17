/**
 * FluentStream is a fluent, chainable wrapper around the low-level Processor
 * for building FFmpeg command arguments and optionally attaching input streams.
 *
 * Provides a convenient builder API for constructing FFmpeg commands,
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
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "../Types/index.js";
/**
 * SimpleFFmpeg provides a convenient, chainable interface for constructing
 * FFmpeg commands. It delegates execution to the low-level Processor.
 *
 * @example
 * const ff = new SimpleFFmpeg({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 */
export declare class FluentStream extends EventEmitter {
    private args;
    private inputStreams;
    private inputFiles;
    private readonly options;
    private pendingFifos;
    private audioTransformConfig?;
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
     * Adds global ffmpeg options to the arguments.
     * @param {...string} opts - The global options to set (e.g. "-hide_banner").
     * @returns {FluentStream} This instance for chaining.
     */
    globalOptions(...opts: string[]): FluentStream;
    /**
     * Adds input-specific ffmpeg options.
     * @param {...string} opts - The options to add before the most recent "-i".
     * @returns {FluentStream} This instance for chaining.
     */
    inputOptions(...opts: string[]): FluentStream;
    /**
     * Adds an input (file path or stream) to the ffmpeg command.
     * @param {string|Readable} input - Path or stream to use as input.
     * @returns {FluentStream} This instance for chaining.
     */
    input(input: string | Readable): FluentStream;
    /**
     * Adds a FIFO (named pipe) as an input.
     * @param {string} fifoPath - Path to the FIFO.
     * @returns {FluentStream} This instance for chaining.
     */
    inputFifo(fifoPath: string): FluentStream;
    /**
     * Prepares and adds a unique FIFO input for a new track, returning its path.
     * @param {Object} [options]
     * @param {string} [options.dir] - Directory for the FIFO.
     * @param {string} [options.prefix] - Prefix for the FIFO filename.
     * @returns {string} The FIFO path.
     */
    prepareNextTrackFifo(options?: {
        dir?: string;
        prefix?: string;
    }): string;
    /**
     * Sets the output file or pipe for the ffmpeg command.
     * @param {string} output - Path or ffmpeg output spec (e.g. "pipe:1").
     * @returns {FluentStream} This instance for chaining.
     */
    output(output: string): FluentStream;
    /**
     * Adds extra options to the end of ffmpeg command (output side).
     * @param {...string} opts - The options to add after outputs.
     * @returns {FluentStream} This instance for chaining.
     */
    outputOptions(...opts: string[]): FluentStream;
    /**
     * Sets the video codec.
     * @param {string} codec - The video codec name.
     * @returns {FluentStream} This instance for chaining.
     */
    videoCodec(codec: string): FluentStream;
    /**
     * Sets the audio codec.
     * @param {string} codec - The audio codec name.
     * @returns {FluentStream} This instance for chaining.
     */
    audioCodec(codec: string): FluentStream;
    /**
     * Sets the video bitrate.
     * @param {string} bitrate - Video bitrate value (e.g. "1000k").
     * @returns {FluentStream} This instance for chaining.
     */
    videoBitrate(bitrate: string): FluentStream;
    /**
     * Sets the audio bitrate.
     * @param {string} bitrate - Audio bitrate value (e.g. "192k").
     * @returns {FluentStream} This instance for chaining.
     */
    audioBitrate(bitrate: string): FluentStream;
    /**
     * Sets the target video size.
     * @param {string} size - The target size, e.g. "640x480".
     * @returns {FluentStream} This instance for chaining.
     */
    size(size: string): FluentStream;
    /**
     * Sets the output video fps.
     * @param {number} fps - Frames per second.
     * @returns {FluentStream} This instance for chaining.
     */
    fps(fps: number): FluentStream;
    /**
     * Sets the output duration.
     * @param {string|number} duration - Output duration (seconds or ffmpeg duration string).
     * @returns {FluentStream} This instance for chaining.
     */
    duration(duration: string | number): FluentStream;
    /**
     * Sets the start time offset for input.
     * @param {string|number} time - Time offset (seconds or ffmpeg timestamp string).
     * @returns {FluentStream} This instance for chaining.
     */
    seek(time: string | number): FluentStream;
    /**
     * Sets the output format.
     * @param {string} format - Output format, e.g. "mp4" or "mp3".
     * @returns {FluentStream} This instance for chaining.
     */
    format(format: string): FluentStream;
    /**
     * Enables overwrite of output files.
     * @returns {FluentStream} This instance for chaining.
     */
    overwrite(): FluentStream;
    /**
     * Disables overwrite of output files (fail if exists).
     * @returns {FluentStream} This instance for chaining.
     */
    noOverwrite(): FluentStream;
    /**
     * Sets a complex filter for ffmpeg.
     * @param {string} filterGraph - Filter graph string.
     * @returns {FluentStream} This instance for chaining.
     */
    complexFilter(filterGraph: string): FluentStream;
    /**
     * Adds a -map argument.
     * @param {string} label - The ffmpeg stream selector.
     * @returns {FluentStream} This instance for chaining.
     */
    map(label: string): FluentStream;
    /**
     * Adds an audio crossfade filter between two inputs.
     * @param {number} durationSeconds - Duration of the crossfade in seconds.
     * @param {Object} [options] - Additional crossfade options.
     * @param {number} [options.inputA=0] - Index of the first audio input.
     * @param {number} [options.inputB=1] - Index of the second audio input.
     * @param {string} [options.curve1='tri'] - First curve type.
     * @param {string} [options.curve2='tri'] - Second curve type.
     * @returns {FluentStream} This instance for chaining.
     */
    crossfadeAudio(durationSeconds: number, options?: {
        inputA?: number;
        inputB?: number;
        curve1?: string;
        curve2?: string;
    }): FluentStream;
    /**
     * Attach a JS audio transform (a Transform stream) to process PCM data between decode and encode.
     *
     * @param {Transform} transform - The Node.js Transform stream to apply to decoded PCM audio.
     * @param {function(FluentStream):void} buildEncoder - Callback to configure encoding/output (receives a FluentStream).
     * @param {Object} [opts] - Audio transform options.
     * @param {number} [opts.sampleRate=48000] - Sample rate for PCM.
     * @param {number} [opts.channels=2] - Channel count for PCM.
     * @returns {FluentStream} This instance for chaining.
     */
    withAudioTransform(transform: Transform, buildEncoder: (enc: FluentStream) => void, opts?: {
        sampleRate?: number;
        channels?: number;
    }): FluentStream;
    /**
     * Attaches a custom AudioPlugin as a JS transform, and wires up the encoder step.
     *
     * @param {AudioPlugin} plugin - The plugin object (must implement createTransform).
     * @param {function(FluentStream):void} buildEncoder - Encoder customization callback.
     * @param {AudioPluginOptions} [opts] - Audio options.
     * @returns {FluentStream} This instance for chaining.
     */
    withAudioPlugin(plugin: AudioPlugin, buildEncoder: (enc: FluentStream) => void, opts?: AudioPluginOptions): FluentStream;
    /**
     * Execute with the underlying Processor. All processor events are re-emitted.
     *
     * @param {Object} [opts] - Optional. If opts.ffplay is true, will attempt to play the output via ffplay.
     * @returns {FFmpegRunResult} The result object containing the output stream, a done promise, and a stop method.
     */
    run(opts?: {
        ffplay?: boolean;
        [key: string]: any;
    }): FFmpegRunResult;
    /**
     * Returns a copy of the constructed ffmpeg args array.
     * @returns {string[]} Arguments list.
     */
    getArgs(): string[];
    /**
     * Returns the ffmpeg command as a string for debugging.
     * @returns {string} The ffmpeg command.
     */
    toString(): string;
    /**
     * Returns the currently-attached input streams (for pipe).
     * @returns {Array<{stream: Readable, index: number}>} List of input streams.
     */
    getInputStreams(): Array<{
        stream: Readable;
        index: number;
    }>;
    /**
     * Synchronously ensures a FIFO exists at the given filePath (creates it if missing).
     * Throws on error.
     * @private
     * @param {string} filePath - Path to FIFO to check and/or create.
     * @throws {Error} If creation fails or the path exists but is not a FIFO.
     */
    private ensureFifoSync;
}
export { FluentStream as default };
