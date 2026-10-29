import { MiniEmitter } from "hemmiter";
import type { FFmpegRunResultExtended, ProcessorOptions, CrossfadeAudioOptions, LiveCrossfadeOptions, FFmpegProgress } from "../Types/index.js";
import { type DjAnalysis } from "../Audio/analysis/DjAnalysis.js";
import { type AutomixPlan, type AutomixDiagnostic } from "../Audio/analysis/AutomixPlan.js";
export interface PrepareAutomixOptions {
    /** Opt-in independent bass/high-band handoff; does not bypass grid checks. */
    transitionMode?: "crossfade" | "beat-handoff";
    /** Explicit offline-calibrated transition override; bypasses grid gating only when supplied by the caller. */
    transitionOverride?: {
        /** Absolute outgoing source position. Omit to transition at the tail. */
        startMs?: number;
        cueMs: number;
        seconds: number;
        tempoFactor?: number;
    };
    /** Remaining outgoing time sampled when prepareAutomix is called. */
    outgoingRemainingMs: number;
    incomingDurationMs?: number;
    fallbackSeconds?: number;
    explicitDropMs?: number;
    /** Enable pitch-preserving tempo matching for this prepared transition. */
    enableTempoMatch?: boolean;
    /** Maximum absolute tempo correction, default 8%. */
    maxTempoChange?: number;
    outgoingAnalysis?: DjAnalysis;
    /** Trusted cached analysis of the full incoming track. */
    incomingAnalysis?: DjAnalysis;
    /** Decision diagnostics are delivered even when verbose logging is disabled. */
    onDiagnostic?: (diagnostic: AutomixDiagnostic) => void;
    signal?: AbortSignal;
}
export interface PreparedAutomix {
    readonly plan: AutomixPlan;
    /** Arm the PCM schedule once; keep consuming output until this resolves. */
    start(): Promise<void>;
    /** Discard an unstarted preparation. Repeated cancellation is harmless. */
    cancel(): Promise<void>;
}
type FluentStreamEvents = {
    progress: [progress: Partial<FFmpegProgress>];
    error: [error: Error];
    end: [];
    terminated: [signal: string];
};
export default class FluentStream extends MiniEmitter<FluentStreamEvents> {
    static readonly HUMANITY_HEADERS: Readonly<{
        "X-Human-Intent": "true";
        "X-Request-Attention": "just-want-to-do-my-best";
        "User-Agent": "FluentStream/1.0 (friendly bot)";
    }>;
    private outputTargets;
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
    private seekInProgress;
    private playback?;
    private crossfadeInProgress;
    private automixCancellation?;
    private lastRunOptions;
    get volume(): number;
    set volume(value: number);
    get bass(): number;
    set bass(value: number);
    get treble(): number;
    set treble(value: number);
    get mids(): number;
    set mids(value: number);
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
    setMids(value: number): this;
    setCompressor(enabled: boolean): this;
    get karaoke(): boolean;
    set karaoke(value: boolean);
    setKaraoke(enabled: boolean): this;
    changeKaraoke(enabled: boolean): boolean;
    enableAudioProcessing(enable?: boolean): this;
    changeVolume(value: number): boolean;
    changeBass(value: number): boolean;
    changeTreble(value: number): boolean;
    changeMids(value: number): boolean;
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
    /** Seek to an absolute position. Mixed playback retains its output; ordinary runs return a replacement. */
    seek(position: number | string): Promise<FFmpegRunResultExtended>;
    /** Switch the mixer to a restarted decoder without closing the session output. */
    private seekMixedPlayback;
    private parseSeekPosition;
    duration(time: number | string): this;
    audioBitrate(bitrate: string): this;
    videoBitrate(bitrate: string): this;
    overwrite(): this;
    copyCodecs(): this;
    private logCrossfade;
    /** Transition immediately to another file/URL without replacing the PCM output. */
    crossfade(url: string, time?: number, options?: LiveCrossfadeOptions): Promise<void>;
    /**
     * Analyze and prebuffer without starting a transition. Decoder configuration and
     * effects are snapshotted at preparation time; later setters affect only the
     * active decoder until the prepared track becomes active. No EOF hold is taken.
     */
    /** Current PCM generation diagnostics, or null outside a mixed playback session. */
    getPlaybackStats(): import("../Audio/PlaybackMixer.js").PlaybackMixerStats | null;
    prepareAutomix(url: string, options: PrepareAutomixOptions): Promise<PreparedAutomix>;
    private validateMixedPlayback;
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
            mids: number;
            compressor: boolean;
            karaoke: boolean;
            audioProcessor: boolean;
        };
    };
}
export {};
//# sourceMappingURL=FluentStream.d.ts.map