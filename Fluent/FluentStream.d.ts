import { EventEmitter } from "eventemitter3";
import type { FFmpegRunResultExtended, ProcessorOptions, CrossfadeAudioOptions } from "../Types/index.js";
export default class FluentStream extends EventEmitter {
    static readonly HUMANITY_HEADERS: Readonly<{
        "X-Human-Intent": "true";
        "X-Request-Attention": "just-want-to-do-my-best";
        "User-Agent": "FluentStream/1.0 (friendly bot)";
    }>;
    private args;
    private inputStreams;
    private inputSources;
    private complexFilters;
    readonly options: ProcessorOptions;
    private headers;
    private isDirty;
    private audio;
    private logger;
    private processorResult;
    get volume(): number;
    set volume(value: number);
    get bass(): number;
    set bass(value: number);
    get treble(): number;
    set treble(value: number);
    get compressor(): boolean;
    set compressor(value: boolean);
    get useAudioProcessor(): boolean;
    set useAudioProcessor(value: boolean);
    constructor(options?: ProcessorOptions);
    private emitLog;
    private getMergedHeaders;
    private createProcessor;
    private requireClean;
    setVolume(value: number): this;
    fadeIn(targetVolume?: number, durationMs?: number): this;
    fadeOut(durationMs?: number): this;
    setBass(value: number): this;
    setTreble(value: number): this;
    setCompressor(enabled: boolean): this;
    enableAudioProcessing(enable?: boolean): this;
    changeVolume(value: number): boolean;
    changeBass(value: number): boolean;
    changeTreble(value: number): boolean;
    changeCompressor(enabled: boolean): boolean;
    changeNormalize(enabled: boolean): boolean;
    input(input: string | ReadableStream<Uint8Array> | {
        on: (...args: any[]) => any;
        pipe: (...args: any[]) => any;
    } | undefined | null, opts?: {
        label?: string;
        pipeIndex?: number;
        allowDuplicate?: boolean;
    }): this;
    output(output: string | ReadableStream<Uint8Array> | number | {
        pipe?: string;
    } | undefined | null): this;
    getHeaders(): Record<string, string>;
    setHeaders(headers?: Record<string, string> | null, opts?: {
        merge?: boolean;
    }): this;
    userAgent(userAgent?: string | null): this;
    inputOptions(...opts: string[]): this;
    outputOptions(...opts: string[]): this;
    globalOptions(...opts: string[]): this;
    audioCodec(codec: string): this;
    videoCodec(codec: string): this;
    audioFrequency(frequency: number): this;
    audioChannels(channels: number): this;
    format(fmt: string): this;
    noVideo(): this;
    noAudio(): this;
    complexFilter(graph: string | string[]): this;
    map(spec: string): this;
    seekInput(position: number | string): this;
    duration(time: number | string): this;
    audioBitrate(bitrate: string): this;
    videoBitrate(bitrate: string): this;
    overwrite(): this;
    copyCodecs(): this;
    crossfadeAudio(durationSec: number, options?: CrossfadeAudioOptions): this;
    inputBlob(blobUrl: string, index?: number): this;
    clear(): this;
    resetArgs(): this;
    isDirtyState(): boolean;
    isReady(): boolean;
    getArgs(): string[];
    assembleArgs(): string[];
    getInputSummary(): {
        stringInputs: string[];
        urlInputs: string[];
        pipeStreams: string[];
        complexFilters: string[];
    };
    countInputs(): {
        streams: number;
        stringInputs: number;
        urlInputs: number;
        total: number;
    };
    /**
     * Runs the FFmpeg process with the configured arguments and streams.
     * * @remarks
     * Once `.run()` is called, the FluentStream instance becomes **dirty** to prevent
     * accidental multiple executions or state mutations. If you want to reuse this
     * instance for another FFmpeg execution, you must call `.clear()` first.
     * * @example
     * ```ts
     * const result = await stream.input("in.mp3").output("out.wav").run();
     * await result.done;
     * * // For the next run:
     * stream.clear().input("next.mp3").output("next.wav").run();
     * ```
     * * @throws {FluentStreamValidationError} If the stream is dirty (already executed without `.clear()`)
     */
    run(extraOpts?: Partial<ProcessorOptions>): Promise<FFmpegRunResultExtended>;
    static get stdout(): {
        pipe: string;
    };
    static get stderr(): {
        pipe: string;
    };
    static get pipe1(): {
        pipe: "pipe:1";
    };
    static get pipe2(): {
        pipe: "pipe:2";
    };
    toString(): string;
    debugInfo(): {
        isDirty: boolean;
        args: string[];
        inputs: Array<{
            stream: string;
            index: number;
        }>;
        filters: string[];
        audioState: {
            volume: number;
            bass: number;
            treble: number;
            compressor: boolean;
            audioProcessor: boolean;
        };
    };
}
//# sourceMappingURL=FluentStream.d.ts.map