/**
 * Fluent wrapper around the low-level Processor providing a chainable API
 * to build FFmpeg arguments and optionally attach input streams.
 */
import { EventEmitter } from "eventemitter3";
import { type Readable, Transform } from "stream";
import { type AudioPlugin, type AudioPluginOptions } from "./Filters.js";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "src/Types/index.js";
export interface FFmpegProgress {
    frame?: number;
    fps?: number;
    speed?: number;
    progress?: string;
}
/**
 * SimpleFFmpeg provides a convenient, chainable interface for constructing
 * FFmpeg commands. It delegates execution to the low-level Processor.
 *
 * Example:
 * ```ts
 * const ff = new SimpleFFmpeg({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 * ```
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
     * Create a new fluent builder.
     * @param options - default configuration for created Processor
     */
    constructor(options?: SimpleFFmpegOptions);
    /**
     * Insert global options (appear before any inputs), e.g. "-hide_banner".
     */
    globalOptions(...opts: string[]): this;
    /**
     * Insert options that must precede the last input (e.g. "-f lavfi").
     */
    inputOptions(...opts: string[]): this;
    /**
     * Add an input source (filepath or stream). Streams are piped via stdin.
     */
    input(input: string | Readable): this;
    /**
     * Add a named pipe (FIFO) as an input. The FIFO will be created at run() time if missing.
     * This allows позднее подмешивание второго трека: ffmpeg ждёт, пока вы начнёте писать в FIFO.
     */
    inputFifo(fifoPath: string): this;
    /**
     * Prepare a FIFO path and register it as the next input automatically.
     * @returns absolute FIFO path
     */
    prepareNextTrackFifo(options?: {
        dir?: string;
        prefix?: string;
    }): string;
    output(output: string): this;
    /** Add output options (appended near the end, before output). */
    outputOptions(...opts: string[]): this;
    videoCodec(codec: string): this;
    audioCodec(codec: string): this;
    videoBitrate(bitrate: string): this;
    audioBitrate(bitrate: string): this;
    size(size: string): this;
    fps(fps: number): this;
    duration(duration: string | number): this;
    seek(time: string | number): this;
    format(format: string): this;
    overwrite(): this;
    noOverwrite(): this;
    /**
     * Add a custom complex filter string.
     * Example: .complexFilter('[0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[aout]')
     */
    complexFilter(filterGraph: string): this;
    /**
     * Map a specific stream label to output (e.g., '[aout]' or '[vout]').
     */
    map(label: string): this;
    /**
     * Audio crossfade helper using FFmpeg acrossfade filter.
     * Crossfades audio from inputA to inputB for duration seconds.
     * Note: requires at least two inputs. By default uses [0:a] and [1:a].
     */
    crossfadeAudio(durationSeconds: number, options?: {
        inputA?: number;
        inputB?: number;
        curve1?: string;
        curve2?: string;
    }): this;
    /**
     * Enable JS audio processing between decode and encode stages.
     * You provide a Transform (e.g., your AudioProcessor) and a builder to configure the encoder stage.
     * The decoder stage is generated automatically to produce PCM s16le at the given rate/channels.
     */
    withAudioTransform(transform: Transform, buildEncoder: (enc: FluentStream) => void, opts?: {
        sampleRate?: number;
        channels?: number;
    }): this;
    /**
     * Plug-in style audio processing. The plugin returns a Transform; we wire it as withAudioTransform.
     */
    withAudioPlugin(plugin: AudioPlugin, buildEncoder: (enc: FluentStream) => void, opts?: AudioPluginOptions): this;
    /**
     * Execute using the low-level Processor. Subscribes to Processor events
     * and re-emits them from the wrapper instance.
     */
    run(opts?: {
        ffplay?: boolean;
        [key: string]: any;
    }): FFmpegRunResult;
    /** Get a copy of the constructed args. */
    getArgs(): string[];
    /** Get full command string preview. */
    toString(): string;
    /** Get current input streams. */
    getInputStreams(): Array<{
        stream: Readable;
        index: number;
    }>;
    private ensureFifoSync;
}
export { FluentStream as default };
