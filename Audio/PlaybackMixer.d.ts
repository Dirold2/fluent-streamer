import type { LiveCrossfadeOptions } from "../Types/index.js";
type Retire = (() => Promise<void>) & {
    /** Register intentional output cancellation before it reaches the upstream pipeline. */
    prepare?: (reason: unknown) => void;
};
/** Validate before taking ownership of a decoder or locking its output. */
export declare function validateLiveCrossfadeOptions(options: LiveCrossfadeOptions): void;
declare const preparedInputBrand: unique symbol;
/** Opaque, mixer-owned handle; valid only until discarded or scheduled. */
export interface PreparedMixerInput {
    readonly [preparedInputBrand]: true;
}
export interface MixerSchedule {
    startFrame: number;
    beatPeriodFrames?: number;
}
/** Session diagnostics, not evidence of an actual downstream player underrun. */
export interface PlaybackMixerStats {
    /** PCM frames successfully enqueued, including fades/silence; excludes discarded work. */
    readonly emittedFrames: number;
    /** Pulls started, including first demand, EOF, errors and cancellation. */
    readonly pullCount: number;
    /** Longest generation pull; never includes time between consumer reads. */
    readonly maxPullMs: number;
    /** Pulls exceeding max(20 ms, duration of PCM enqueued by that pull). */
    readonly latePullCount: number;
    /** Pulls strictly exceeding the fixed 20 ms PCM deadline (960 frames at 48 kHz).
     * Includes first demand and terminal pulls; does not infer player underruns. */
    readonly deadlineMissCount: number;
    /** Cumulative pull duration, including PCM/preparation waits; finalized in finally. */
    readonly pcmWaitMs: number;
    /** Maximum pull duration (same generation-only clock as maxPullMs). */
    readonly maxPcmWaitMs: number;
    /** Current-source frame waits exceeding 20 ms with no output yet in the pull.
     * Immediate/small reads are not shortages; delayed EOF/errors/cancellation can be. */
    readonly frameShortageCount: number;
    /** EOF waits for a held replacement or incoming crossfade warmup. */
    readonly preparationWaitCount: number;
    readonly preparationWaitMs: number;
    /** Live upstream reader.read() calls, including background prebuffering. */
    readonly pendingReadCount: number;
    /** Complete frames in explicit warmup queues, not upstream chunks or output. */
    readonly prebufferedFrames: number;
    readonly preparing: boolean;
    readonly cleanupPending: boolean;
}
/**
 * A stable, pull-driven interleaved signed little-endian PCM16 output.
 * Crossfades use round(seconds * sampleRate) frames, with new gain (frame + 1) / frames.
 * An input ending during a fade contributes silence; partial final frames are errors.
 * Crossfade requests prebuffer at most 20 ms / 1024 frames; otherwise reads follow demand.
 * Each output chunk is at most 1024 frames.
 */
export declare class PlaybackMixer {
    private readonly sampleRate;
    private readonly channels;
    readonly output: ReadableStream<Uint8Array>;
    /** Session completion after cleanup; intentional cancellation is successful. */
    readonly done: Promise<void>;
    private resolveDone;
    private rejectDone;
    private doneSettled;
    private readonly frameBytes;
    private current;
    private readonly inputs;
    private transition?;
    private prepared?;
    private sourcePosition;
    private readonly diagnostics;
    /** Frozen point-in-time snapshot. Counters span this mixer session and never reset.
     * Timing uses performance.now(), with no playback scheduling, timers or logging. */
    get stats(): PlaybackMixerStats;
    /** PCM frames consumed/emitted from the current source, not the session timeline. */
    get sourceFrame(): number;
    private controller;
    private closed;
    private cleanup?;
    private preparation?;
    /** Keep the session open at EOF while a replacement decoder is starting. */
    hold(): () => void;
    constructor(initial: ReadableStream<Uint8Array>, sampleRate: number, channels: number, onRetire: Retire);
    /** Prebuffer at most 20 ms / 1024 frames without changing the current source. */
    prepare(next: ReadableStream<Uint8Array>, onRetire: Retire): Promise<PreparedMixerInput>;
    discardPrepared(token: PreparedMixerInput): Promise<void>;
    crossfadePrepared(token: PreparedMixerInput, seconds: number, options?: LiveCrossfadeOptions, schedule?: MixerSchedule): Promise<void>;
    crossfade(next: ReadableStream<Uint8Array>, seconds: number, onRetire: Retire, options?: LiveCrossfadeOptions): Promise<void>;
    /**
     * Serial seek: fade out, switch inputs, then fade in without overlapping timelines.
     * Each phase lasts round(fadeSeconds * sampleRate) frames (default 20 ms).
     * The new input starts at zero and reaches one on its last fade frame; a one-frame
     * fade-in emits only the zero frame, followed by unscaled audio. Zero frames switch instantly.
     * onRetire belongs to next. Completion includes both PCM phases, not background retirement.
     */
    seek(next: ReadableStream<Uint8Array>, fadeSeconds: number | undefined, onRetire: Retire): Promise<void>;
    private startTransition;
    /** Closes output, interrupts pending reads, and awaits cancellation and retirement. */
    stop(reason?: unknown): Promise<void>;
    cancel(reason?: unknown): Promise<void>;
    private finish;
    private settleDone;
    private complete;
    private canMix;
    private currentFrame;
    private waitForPreparation;
    private pull;
    private enqueue;
}
export default PlaybackMixer;
//# sourceMappingURL=PlaybackMixer.d.ts.map