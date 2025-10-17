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
     * @param options - default configuration for created Processor
     * @example
     * const ff = new FluentStream({ enableProgressTracking: true });
     */
    constructor(options?: SimpleFFmpegOptions);
    /**
     * Insert global options (appear before any inputs), e.g. "-hide_banner".
     * @param {...string} opts - one or more global arguments for ffmpeg.
     * @returns {FluentStream}
     * @example
     * ff.globalOptions('-hide_banner');
     */
    globalOptions(...opts: string[]): FluentStream;
    /**
     * Insert options that must precede the last input (e.g. "-f lavfi").
     * @param {...string} opts
     * @returns {FluentStream}
     * @example
     * ff.inputOptions('-f', 'lavfi');
     */
    inputOptions(...opts: string[]): FluentStream;
    /**
     * Add an input source (filepath or stream). Streams are piped via stdin.
     * @param {string|Readable} input - file path or readable stream
     * @returns {FluentStream}
     * @example
     * ff.input('input.mp3')
     *   .input(someStream);
     */
    input(input: string | Readable): FluentStream;
    /**
     * Add a named pipe (FIFO) as an input. FIFO is created at run() if missing.
     *
     * @param {string} fifoPath
     * @returns {FluentStream}
     * @example
     * ff.inputFifo('/tmp/somefifo');
     */
    inputFifo(fifoPath: string): FluentStream;
    /**
     * Prepare a FIFO path and register it as the next input automatically.
     * @param {object} [options] - options for FIFO creation
     * @param {string} [options.dir] - directory to create FIFO in
     * @param {string} [options.prefix] - prefix for FIFO filename
     * @returns {string} absolute FIFO path
     * @example
     * const fifoPath = ff.prepareNextTrackFifo();
     * // Write to fifoPath asynchronously.
     */
    prepareNextTrackFifo(options?: {
        dir?: string;
        prefix?: string;
    }): string;
    /**
     * Specify output target (file path, or ffmpeg stream target string).
     * @param {string} output
     * @returns {FluentStream}
     * @example
     * ff.output('output.mp3')
     */
    output(output: string): FluentStream;
    /**
     * Add output options (appended before output).
     * @param {...string} opts
     * @returns {FluentStream}
     * @example
     * ff.outputOptions('-b:a', '128k');
     */
    outputOptions(...opts: string[]): FluentStream;
    /**
     * Set video codec.
     * @param {string} codec
     * @returns {FluentStream}
     * @example
     * ff.videoCodec('libx264');
     */
    videoCodec(codec: string): FluentStream;
    /**
     * Set audio codec.
     * @param {string} codec
     * @returns {FluentStream}
     * @example
     * ff.audioCodec('aac');
     */
    audioCodec(codec: string): FluentStream;
    /**
     * Set video bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     * @example
     * ff.videoBitrate('1M');
     */
    videoBitrate(bitrate: string): FluentStream;
    /**
     * Set audio bitrate.
     * @param {string} bitrate
     * @returns {FluentStream}
     * @example
     * ff.audioBitrate('128k');
     */
    audioBitrate(bitrate: string): FluentStream;
    /**
     * Set output video size.
     * @param {string} size
     * @returns {FluentStream}
     * @example
     * ff.size('640x480');
     */
    size(size: string): FluentStream;
    /**
     * Set output frames per second.
     * @param {number} fps
     * @returns {FluentStream}
     * @example
     * ff.fps(24);
     */
    fps(fps: number): FluentStream;
    /**
     * Limit duration.
     * @param {string|number} duration - seconds or ffmpeg time string
     * @returns {FluentStream}
     * @example
     * ff.duration(10);
     */
    duration(duration: string | number): FluentStream;
    /**
     * Seek input.
     * @param {string|number} time - seconds or ffmpeg time string
     * @returns {FluentStream}
     * @example
     * ff.seek(2.5);
     */
    seek(time: string | number): FluentStream;
    /**
     * Set container/output format.
     * @param {string} format - e.g. 'mp3'
     * @returns {FluentStream}
     * @example
     * ff.format('wav');
     */
    format(format: string): FluentStream;
    /**
     * Force overwrite output.
     * @returns {FluentStream}
     * @example
     * ff.overwrite();
     */
    overwrite(): FluentStream;
    /**
     * Forbid overwrite output.
     * @returns {FluentStream}
     * @example
     * ff.noOverwrite();
     */
    noOverwrite(): FluentStream;
    /**
     * Add a custom complex filter string.
     * @param {string} filterGraph
     * @returns {FluentStream}
     * @example
     * ff.complexFilter('[0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[aout]');
     */
    complexFilter(filterGraph: string): FluentStream;
    /**
     * Map a specific stream label to output (e.g., '[aout]' or '[vout]').
     * @param {string} label
     * @returns {FluentStream}
     * @example
     * ff.map('[aout]');
     */
    map(label: string): FluentStream;
    /**
     * Audio crossfade helper using FFmpeg acrossfade filter.
     * Crossfades audio from inputA to inputB for duration seconds.
     * Note: requires at least two inputs. By default uses [0:a] and [1:a].
     *
     * @param {number} durationSeconds
     * @param {object} [options]
     * @param {number} [options.inputA] - Index of first input (default: 0)
     * @param {number} [options.inputB] - Index of second input (default: 1)
     * @param {string} [options.curve1] - Fade curve type for inputA (default: "tri")
     * @param {string} [options.curve2] - Fade curve type for inputB (default: "tri")
     * @returns {FluentStream}
     * @example
     * ff.crossfadeAudio(4);
     */
    crossfadeAudio(durationSeconds: number, options?: {
        inputA?: number;
        inputB?: number;
        curve1?: string;
        curve2?: string;
    }): FluentStream;
    /**
     * Enable JS audio processing between decode and encode stages.
     * You provide a Transform (e.g., your AudioProcessor) and a builder to configure the encoder stage.
     * The decoder stage is generated automatically to produce PCM s16le at the given rate/channels.
     *
     * @param {Transform} transform - Node.js Transform stream
     * @param {(enc:FluentStream)=>void} buildEncoder - function to configure output/encoding
     * @param {object} [opts]
     * @param {number} [opts.sampleRate=48000]
     * @param {number} [opts.channels=2]
     * @returns {FluentStream}
     * @example
     * // Pipe decoded PCM through custom processor:
     * ff.withAudioTransform(myAudioTransform, enc => enc.audioCodec('aac').output('file.aac'));
     */
    withAudioTransform(transform: Transform, buildEncoder: (enc: FluentStream) => void, opts?: {
        sampleRate?: number;
        channels?: number;
    }): FluentStream;
    /**
     * Plug-in style audio processing.
     * The plugin returns a Transform; we wire it as withAudioTransform.
     * @param {AudioPlugin} plugin
     * @param {(enc:FluentStream)=>void} buildEncoder
     * @param {AudioPluginOptions} [opts]
     * @returns {FluentStream}
     */
    withAudioPlugin(plugin: AudioPlugin, buildEncoder: (enc: FluentStream) => void, opts?: AudioPluginOptions): FluentStream;
    /**
     * Execute using the low-level Processor. Subscribes to Processor events
     * and re-emits them from the wrapper instance.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.ffplay] - pipe output to ffplay for previewing
     * @returns {FFmpegRunResult}
     * @example
     * const { output, done } = ff.run();
     */
    run(opts?: {
        ffplay?: boolean;
        [key: string]: any;
    }): FFmpegRunResult;
    /**
     * Get a copy of the constructed ffmpeg argument list.
     * @returns {string[]}
     * @example
     * const args = ff.getArgs();
     */
    getArgs(): string[];
    /**
     * Get full ffmpeg command string preview (not guaranteed to be shell-escaped).
     * @returns {string}
     * @example
     * ff.toString() // 'ffmpeg ...'
     */
    toString(): string;
    /**
     * Get current input streams.
     * @returns {Array<{stream:Readable, index:number}>}
     */
    getInputStreams(): Array<{
        stream: Readable;
        index: number;
    }>;
    /**
     * Synchronously ensure FIFO exists at filePath (creates it if missing).
     * Throws on error.
     * @private
     * @param {string} filePath
     */
    private ensureFifoSync;
}
export { FluentStream as default };
