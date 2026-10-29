import type { LiveCrossfadeOptions } from "../Types/index.js";

type Retire = (() => Promise<void>) & {
  /** Register intentional output cancellation before it reaches the upstream pipeline. */
  prepare?: (reason: unknown) => void;
};

/** Owns one reader, one upstream chunk, and a bounded optional crossfade prebuffer. */
class Input {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private ended = false;
  private disposal?: Promise<void>;
  private prebuffer: Uint8Array[] = [];
  private warmup?: Promise<void>;
  private warming = false;
  pendingReadCount = 0;

  get prebufferedFrames(): number {
    return this.prebuffer.length;
  }

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly retire: Retire,
  ) {
    this.reader = stream.getReader();
  }

  get prebufferReady(): boolean {
    return !this.warming;
  }

  prefetch(bytes: number, frames: number): Promise<void> {
    if (!this.warmup) {
      this.warming = true;
      this.warmup = Promise.resolve().then(async () => {
        try {
          for (let i = 0; i < frames && !this.disposal; i++) {
            const frame = await this.readFrame(bytes);
            if (!frame || this.disposal) break;
            // Do not retain a potentially large upstream chunk for each buffered frame.
            this.prebuffer.push(frame.slice());
          }
        } finally {
          this.warming = false;
        }
      });
      void this.warmup.catch(() => {});
    }
    return this.warmup;
  }

  ready(bytes: number): boolean {
    return (
      !this.warming &&
      (this.prebuffer.length > 0 || this.ended || this.chunk.byteLength - this.offset >= bytes)
    );
  }

  async frame(bytes: number): Promise<Uint8Array | null> {
    // Warmup is the only reader until it settles, including during cancellation.
    if (this.warmup) await this.warmup;
    return this.prebuffer.shift() ?? this.readFrame(bytes);
  }

  private async readFrame(bytes: number): Promise<Uint8Array | null> {
    let partial: Uint8Array | undefined;
    let filled = 0;
    while (true) {
      const available = this.chunk.byteLength - this.offset;
      if (available >= bytes && !partial) {
        const frame = this.chunk.subarray(this.offset, this.offset + bytes);
        this.offset += bytes;
        return frame;
      }
      if (available) {
        partial ??= new Uint8Array(bytes);
        const count = Math.min(available, bytes - filled);
        partial.set(this.chunk.subarray(this.offset, this.offset + count), filled);
        this.offset += count;
        filled += count;
        if (filled === bytes) return partial;
      }
      if (this.disposal) return null;
      if (this.ended) {
        if (filled) throw new Error("Truncated PCM16 audio frame");
        return null;
      }
      this.pendingReadCount++;
      try {
        const result = await this.reader.read();
        this.ended = result.done;
        this.chunk = result.value ?? new Uint8Array(0);
        this.offset = 0;
      } finally {
        this.pendingReadCount--;
      }
    }
  }

  dispose(reason?: unknown): Promise<void> {
    if (!this.disposal) {
      // Defer user code so reentrant cleanup sees the memoized promise.
      this.disposal = Promise.resolve().then(async () => {
        this.retire.prepare?.(reason);
        // Detach and finish cancellation before retirement can error upstream output.
        const results = await Promise.allSettled([this.reader.cancel(reason), this.warmup]);
        results.push(...(await Promise.allSettled([Promise.resolve().then(() => this.retire())])));
        this.prebuffer = [];
        this.chunk = new Uint8Array(0);
        this.reader.releaseLock();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      void this.disposal.catch(() => {});
    }
    return this.disposal;
  }
}

/** Validate before taking ownership of a decoder or locking its output. */
export function validateLiveCrossfadeOptions(options: LiveCrossfadeOptions): void {
  if (!options || typeof options !== "object") throw new RangeError("Invalid crossfade options");
  if (options.mode !== undefined && options.mode !== "crossfade" && options.mode !== "beat-handoff")
    throw new RangeError("Invalid crossfade mode");
  if (options.curve !== undefined && options.curve !== "linear" && options.curve !== "equalPower")
    throw new RangeError("Invalid crossfade curve");
  if (options.bassHandoff !== undefined && typeof options.bassHandoff !== "boolean")
    throw new RangeError("Invalid crossfade bassHandoff: expected boolean");
  for (const [name, min, max] of [
    ["startTime", 0, Number.MAX_SAFE_INTEGER],
    ["outgoingBassDb", -60, 0],
    ["bassCutoffHz", 20, 1000],
    ["headroomDb", 0, 12],
  ] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max))
      throw new RangeError(`Invalid crossfade ${name}: expected ${min}..${max}`);
  }
}

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

interface Transition {
  options: LiveCrossfadeOptions;
  lowBand: Float64Array;
  incomingLowBand: Float64Array;
  samples: Float64Array;
  lowAlpha: number;
  phase: "crossfade" | "out" | "in";
  next: Input;
  frames: number;
  position: number;
  incomingConsumed: number;
  schedule?: MixerSchedule;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * A stable, pull-driven interleaved signed little-endian PCM16 output.
 * Crossfades use round(seconds * sampleRate) frames, with new gain (frame + 1) / frames.
 * An input ending during a fade contributes silence; partial final frames are errors.
 * Crossfade requests prebuffer at most 20 ms / 1024 frames; otherwise reads follow demand.
 * Each output chunk is at most 1024 frames.
 */
export class PlaybackMixer {
  readonly output: ReadableStream<Uint8Array>;
  /** Session completion after cleanup; intentional cancellation is successful. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (reason: unknown) => void;
  private doneSettled = false;
  private readonly frameBytes: number;
  private current: Input;
  private readonly inputs = new Set<Input>();
  private transition?: Transition;
  private prepared?: { token: PreparedMixerInput; input: Input; ready: boolean };
  private sourcePosition = 0;
  private readonly diagnostics = {
    emittedFrames: 0,
    pullCount: 0,
    maxPullMs: 0,
    latePullCount: 0,
    deadlineMissCount: 0,
    pcmWaitMs: 0,
    maxPcmWaitMs: 0,
    frameShortageCount: 0,
    preparationWaitCount: 0,
    preparationWaitMs: 0,
  };

  /** Frozen point-in-time snapshot. Counters span this mixer session and never reset.
   * Timing uses performance.now(), with no playback scheduling, timers or logging. */
  get stats(): PlaybackMixerStats {
    let pendingReadCount = 0;
    let prebufferedFrames = 0;
    for (const input of this.inputs) {
      pendingReadCount += input.pendingReadCount;
      prebufferedFrames += input.prebufferedFrames;
    }
    return Object.freeze({
      ...this.diagnostics,
      pendingReadCount,
      prebufferedFrames,
      preparing:
        !!this.preparation ||
        !!this.prepared ||
        !!(this.transition && !this.transition.next.prebufferReady),
      cleanupPending: !!this.cleanup && !this.doneSettled,
    });
  }

  /** PCM frames consumed/emitted from the current source, not the session timeline. */
  get sourceFrame(): number {
    return this.sourcePosition;
  }
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private cleanup?: Promise<void>;
  private preparation?: { promise: Promise<void>; release: () => void };

  /** Keep the session open at EOF while a replacement decoder is starting. */
  hold(): () => void {
    if (this.closed) throw new Error("PlaybackMixer is stopped");
    if (this.preparation) throw new Error("A replacement is already preparing");
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparation = { promise, release };
    this.preparation = preparation;
    return () => {
      if (this.preparation === preparation) this.preparation = undefined;
      release();
    };
  }

  constructor(
    initial: ReadableStream<Uint8Array>,
    private readonly sampleRate: number,
    private readonly channels: number,
    onRetire: Retire,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError("sampleRate must be finite and positive");
    }
    if (!Number.isSafeInteger(channels) || channels <= 0 || channels > 1024) {
      throw new RangeError("channels must be an integer between 1 and 1024");
    }
    this.frameBytes = channels * 2;
    this.current = new Input(initial, onRetire);
    this.inputs.add(this.current);
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    void this.done.catch(() => {});
    this.output = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => this.pull(),
        cancel: (reason) => this.finish(reason, false),
      },
      { highWaterMark: 0 },
    );
  }

  /** Prebuffer at most 20 ms / 1024 frames without changing the current source. */
  async prepare(next: ReadableStream<Uint8Array>, onRetire: Retire): Promise<PreparedMixerInput> {
    if (this.closed) throw new Error("PlaybackMixer is stopped");
    if (this.transition || this.prepared) throw new Error("A replacement is already active");
    const input = new Input(next, onRetire);
    const prepared = { token: Object.freeze({}) as PreparedMixerInput, input, ready: false };
    this.prepared = prepared;
    this.inputs.add(input);
    try {
      await input.prefetch(
        this.frameBytes,
        Math.max(1, Math.min(1024, Math.round(this.sampleRate * 0.02))),
      );
      if (this.closed || this.prepared !== prepared)
        throw new Error("Prepared input was discarded or playback stopped");
      prepared.ready = true;
      return prepared.token;
    } catch (error) {
      if (this.prepared === prepared) this.prepared = undefined;
      await input.dispose(error).then(
        () => this.inputs.delete(input),
        () => {},
      );
      throw error;
    }
  }

  async discardPrepared(token: PreparedMixerInput): Promise<void> {
    if (!this.prepared || this.prepared.token !== token) throw new Error("Invalid prepared input");
    const { input } = this.prepared;
    this.prepared = undefined;
    await input.dispose();
    this.inputs.delete(input);
  }

  crossfadePrepared(
    token: PreparedMixerInput,
    seconds: number,
    options: LiveCrossfadeOptions = {},
    schedule?: MixerSchedule,
  ): Promise<void> {
    return this.startTransition(
      undefined,
      seconds,
      undefined,
      "crossfade",
      options,
      token,
      schedule,
    );
  }

  crossfade(
    next: ReadableStream<Uint8Array>,
    seconds: number,
    onRetire: Retire,
    options: LiveCrossfadeOptions = {},
  ): Promise<void> {
    return this.startTransition(next, seconds, onRetire, "crossfade", options);
  }

  /**
   * Serial seek: fade out, switch inputs, then fade in without overlapping timelines.
   * Each phase lasts round(fadeSeconds * sampleRate) frames (default 20 ms).
   * The new input starts at zero and reaches one on its last fade frame; a one-frame
   * fade-in emits only the zero frame, followed by unscaled audio. Zero frames switch instantly.
   * onRetire belongs to next. Completion includes both PCM phases, not background retirement.
   */
  seek(next: ReadableStream<Uint8Array>, fadeSeconds = 0.02, onRetire: Retire): Promise<void> {
    return this.startTransition(next, fadeSeconds, onRetire, "out");
  }

  private startTransition(
    next: ReadableStream<Uint8Array> | undefined,
    seconds: number,
    onRetire: Retire | undefined,
    phase: "crossfade" | "out",
    options: LiveCrossfadeOptions = {},
    token?: PreparedMixerInput,
    schedule?: MixerSchedule,
  ): Promise<void> {
    try {
      if (this.closed) throw new Error("PlaybackMixer is stopped");
      if (this.transition) throw new Error("A crossfade is already active");
      if (
        token
          ? !this.prepared || this.prepared.token !== token || !this.prepared.ready
          : this.prepared
      )
        throw new Error("Invalid or already active prepared input");
      if (schedule) {
        if (
          !Number.isSafeInteger(schedule.startFrame) ||
          schedule.startFrame < 0 ||
          (schedule.beatPeriodFrames !== undefined &&
            (!Number.isSafeInteger(schedule.beatPeriodFrames) || schedule.beatPeriodFrames <= 0))
        )
          throw new RangeError("Invalid crossfade schedule");
        schedule = { ...schedule };
        if (schedule.beatPeriodFrames && this.sourcePosition > schedule.startFrame) {
          schedule.startFrame +=
            Math.ceil((this.sourcePosition - schedule.startFrame) / schedule.beatPeriodFrames) *
            schedule.beatPeriodFrames;
          if (!Number.isSafeInteger(schedule.startFrame))
            throw new RangeError("Invalid crossfade schedule");
        }
      }
      const frames = Math.round(seconds * this.sampleRate);
      if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(frames)) {
        throw new RangeError(
          phase === "crossfade" ? "Invalid crossfade duration" : "Invalid seek duration",
        );
      }
      validateLiveCrossfadeOptions(options);
      // Snapshot caller-owned options; changes during playback must not alter the envelope.
      options = { ...options };
      const input = token ? this.prepared!.input : new Input(next!, onRetire!);
      if (token) this.prepared = undefined;
      this.inputs.add(input);
      const promise = new Promise<void>((resolve, reject) => {
        this.transition = {
          phase,
          next: input,
          frames,
          position: 0,
          incomingConsumed: 0,
          schedule,
          resolve,
          reject,
          options,
          lowBand: new Float64Array(this.channels),
          incomingLowBand: new Float64Array(this.channels),
          samples: new Float64Array(this.channels),
          lowAlpha:
            1 -
            Math.exp(
              (-2 * Math.PI * Math.min(options.bassCutoffHz ?? 180, this.sampleRate * 0.45)) /
                this.sampleRate,
            ),
        };
      });
      if (phase === "crossfade") {
        const bufferedFrames = Math.max(1, Math.min(1024, Math.round(this.sampleRate * 0.02)));
        void input.prefetch(this.frameBytes, bufferedFrames).catch((error: unknown) => {
          if (!this.closed) void this.finish(error, false, true).catch(() => {});
        });
      }
      // The caller may choose to await completion only after draining output.
      void promise.catch(() => {});
      return promise;
    } catch (error) {
      const rejected = Promise.reject<void>(error);
      void rejected.catch(() => {});
      return rejected;
    }
  }

  /** Closes output, interrupts pending reads, and awaits cancellation and retirement. */
  stop(reason: unknown = new Error("PlaybackMixer stopped")): Promise<void> {
    return this.finish(reason, true);
  }

  cancel(reason?: unknown): Promise<void> {
    return this.stop(reason);
  }

  private finish(reason: unknown, closeOutput: boolean, failed = false): Promise<void> {
    if (this.cleanup) return this.cleanup;
    const wasClosed = this.closed;
    this.closed = true;
    this.preparation?.release();
    this.preparation = undefined;
    this.transition?.reject(reason);
    this.transition = undefined;
    this.prepared = undefined;
    if (!wasClosed) {
      if (failed) this.controller.error(reason);
      else if (closeOutput) this.controller.close();
    }
    this.cleanup = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        [...this.inputs].map((input) => input.dispose(reason)),
      );
      this.inputs.clear();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    void this.cleanup.then(
      () => this.settleDone(failed, reason),
      (error: unknown) => this.settleDone(true, failed ? reason : error),
    );
    return this.cleanup;
  }

  private settleDone(failed: boolean, reason?: unknown): void {
    if (this.doneSettled) return;
    this.doneSettled = true;
    if (failed) this.rejectDone(reason);
    else this.resolveDone();
  }

  private complete(transition: Transition): void {
    if (transition.phase !== "in") {
      const previous = this.current;
      this.current = transition.next;
      this.sourcePosition = transition.incomingConsumed;
      // Keep pending and failed disposals owned until finish() accounts for them.
      // A slow or failing retirement must never block PCM generation.
      void previous.dispose().then(
        () => this.inputs.delete(previous),
        () => {},
      );
      if (this.closed) return;
      if (transition.phase === "out" && transition.frames > 0) {
        transition.phase = "in";
        transition.position = 0;
        return;
      }
    }
    if (this.closed) return;
    this.transition = undefined;
    transition.resolve();
  }

  private canMix(transition: Transition): boolean {
    if (!transition.next.prebufferReady) return false;
    const schedule = transition.schedule;
    if (!schedule) return true;
    if (transition.position > 0) return true;
    if (this.sourcePosition > schedule.startFrame && schedule.beatPeriodFrames) {
      schedule.startFrame +=
        Math.ceil((this.sourcePosition - schedule.startFrame) / schedule.beatPeriodFrames) *
        schedule.beatPeriodFrames;
    }
    return this.sourcePosition >= schedule.startFrame;
  }

  private async currentFrame(): Promise<Uint8Array | null> {
    if (this.current.ready(this.frameBytes)) return this.current.frame(this.frameBytes);
    const start = performance.now();
    try {
      return await this.current.frame(this.frameBytes);
    } finally {
      if (performance.now() - start > 20) this.diagnostics.frameShortageCount++;
    }
  }

  private async waitForPreparation(promise: Promise<void>): Promise<void> {
    const start = performance.now();
    this.diagnostics.preparationWaitCount++;
    try {
      await promise;
    } finally {
      this.diagnostics.preparationWaitMs += performance.now() - start;
    }
  }

  private async pull(): Promise<void> {
    const start = performance.now();
    const before = this.diagnostics.emittedFrames;
    this.diagnostics.pullCount++;
    try {
      const output = new Uint8Array(1024 * this.frameBytes);
      const view = new DataView(output.buffer);
      let count = 0;
      while (!this.closed && count < 1024) {
        let transition = this.transition;
        const mixing = transition?.phase === "crossfade" && this.canMix(transition);
        if (transition && transition.frames === 0 && (transition.phase !== "crossfade" || mixing)) {
          this.complete(transition);
          continue;
        }
        // Publish available frames rather than waiting for another live chunk.
        if (
          count &&
          (!this.current.ready(this.frameBytes) ||
            (mixing && !transition!.next.ready(this.frameBytes)))
        )
          break;
        const started = transition;
        const [old, prefetched] = mixing
          ? await Promise.all([this.currentFrame(), started!.next.frame(this.frameBytes)])
          : [await this.currentFrame(), undefined];
        if (this.closed) return;
        // A transition can be requested while the old reader is pending.
        transition = this.transition;
        if (!transition) {
          if (!old) {
            if (this.preparation) {
              if (count) break;
              await this.waitForPreparation(this.preparation.promise);
              if (this.closed) return;
              if (this.transition) continue;
            }
            if (count) this.enqueue(output, count);
            // EOF is observable immediately; done/stop still wait for every disposal.
            void this.finish(undefined, true).catch(() => {});
            return;
          }
          output.set(old, count++ * this.frameBytes);
          this.sourcePosition++;
        } else {
          if (transition.phase === "crossfade" && !this.canMix(transition)) {
            if (old) {
              output.set(old, count++ * this.frameBytes);
              this.sourcePosition++;
            } else {
              if (transition.schedule && transition.next.prebufferReady) {
                // Error on the next pull so already-generated PCM is delivered first;
                // controller.error() would otherwise discard queued output.
                if (count) break;
                void this.finish(
                  new Error("Source ended before scheduled crossfade"),
                  false,
                  true,
                ).catch(() => {});
                return;
              }
              // Only an exhausted old input may wait for warmup. Publish any
              // already-generated PCM before that unavoidable wait.
              if (count) break;
              await this.waitForPreparation(transition.next.prefetch(this.frameBytes, 1));
            }
            continue;
          }
          if (transition.frames === 0) {
            this.complete(transition);
            continue;
          }
          if (transition.phase !== "crossfade") {
            const gain =
              transition.phase === "out"
                ? 1 - (transition.position + 1) / transition.frames
                : transition.frames === 1
                  ? 0
                  : transition.position / (transition.frames - 1);
            const frame = old && new DataView(old.buffer, old.byteOffset, old.byteLength);
            for (let channel = 0; channel < this.channels; channel++) {
              const offset = channel * 2;
              view.setInt16(
                count * this.frameBytes + offset,
                Math.round((frame?.getInt16(offset, true) ?? 0) * gain),
                true,
              );
            }
            count++;
            if (old) this.sourcePosition++;
            if (++transition.position === transition.frames) {
              this.complete(transition);
              // Publish the phase boundary before waiting for the other timeline.
              break;
            }
            continue;
          }
          const next =
            mixing && started === transition
              ? prefetched
              : await transition.next.frame(this.frameBytes);
          if (this.closed) return;
          if (old) this.sourcePosition++;
          if (next) transition.incomingConsumed++;
          const gain = ++transition.position / transition.frames;
          const oldView = old && new DataView(old.buffer, old.byteOffset, old.byteLength);
          const nextView = next && new DataView(next.buffer, next.byteOffset, next.byteLength);
          const options = transition.options;
          const bandHandoff = options.mode === "beat-handoff";
          const ramp = (value: number) => Math.max(0, Math.min(1, value));
          const incomingHighGain = bandHandoff ? ramp(gain * 4) : 0;
          const outgoingHighGain = bandHandoff ? 1 - ramp((gain - 0.75) * 4) : 0;
          const bandBassGain = bandHandoff ? ramp((gain - 0.375) * 4) : 0;
          const equalPower = options.curve === "equalPower";
          const oldGain = equalPower ? Math.cos((gain * Math.PI) / 2) : 1 - gain;
          const nextGain = equalPower ? Math.sin((gain * Math.PI) / 2) : gain;
          // Smooth endpoint-unity headroom avoids a level step when the overlap ends.
          const headroom = 10 ** ((-(options.headroomDb ?? 0) * Math.sin(Math.PI * gain)) / 20);
          const smooth = gain * gain * (3 - 2 * gain);
          const bassGain = 10 ** (((options.outgoingBassDb ?? 0) * smooth) / 20);
          const handoffProgress = Math.max(0, Math.min(1, (gain - 0.35) / 0.3));
          const handoff = handoffProgress * handoffProgress * (3 - 2 * handoffProgress);
          const oldLowFactor = (1 - handoff) * bassGain;
          const samples = transition.samples;
          let peak = 32767;
          for (let channel = 0; channel < this.channels; channel++) {
            const offset = channel * 2;
            const outgoing = oldView?.getInt16(offset, true) ?? 0;
            const previousLow = transition.lowBand[channel]!;
            const low = previousLow + transition.lowAlpha * (outgoing - previousLow);
            transition.lowBand[channel] = low;
            const incoming = nextView?.getInt16(offset, true) ?? 0;
            if (options.bassHandoff || bandHandoff) {
              const previousIncomingLow = transition.incomingLowBand[channel]!;
              const incomingLow =
                previousIncomingLow + transition.lowAlpha * (incoming - previousIncomingLow);
              transition.incomingLowBand[channel] = incomingLow;
              // Shape each low band before its main envelope; do not apply that gain twice.
              samples[channel] = bandHandoff
                ? ((outgoing - low) * outgoingHighGain +
                    low * (1 - bandBassGain) +
                    (incoming - incomingLow) * incomingHighGain +
                    incomingLow * bandBassGain) *
                  headroom
                : ((outgoing + (oldLowFactor - 1) * low) * oldGain +
                    (incoming + (handoff - 1) * incomingLow) * nextGain) *
                  headroom;
            } else {
              samples[channel] =
                ((outgoing + (bassGain - 1) * low) * oldGain + incoming * nextGain) * headroom;
            }
            peak = Math.max(peak, Math.abs(samples[channel]!));
          }
          // Opt-in shaping uses a stereo-linked instantaneous peak guard: no wraparound,
          // no channel-image shift. Legacy linear rounding/saturation stays byte-identical.
          const shaped =
            bandHandoff ||
            equalPower ||
            !!options.outgoingBassDb ||
            !!options.headroomDb ||
            !!options.bassHandoff;
          const protection = shaped ? 32767 / peak : 1;
          for (let channel = 0; channel < this.channels; channel++) {
            view.setInt16(
              count * this.frameBytes + channel * 2,
              Math.max(-32768, Math.min(32767, Math.round(samples[channel]! * protection))),
              true,
            );
          }
          count++;
          if (transition.position === transition.frames) {
            this.complete(transition);
            // Publish the final fade frame without waiting on the next source read.
            break;
          }
        }
      }
      if (!this.closed && count) this.enqueue(output, count);
    } catch (error) {
      if (!this.closed) void this.finish(error, false, true).catch(() => {});
    } finally {
      const elapsed = performance.now() - start;
      const duration = ((this.diagnostics.emittedFrames - before) / this.sampleRate) * 1000;
      this.diagnostics.pcmWaitMs += elapsed;
      this.diagnostics.maxPullMs = Math.max(this.diagnostics.maxPullMs, elapsed);
      this.diagnostics.maxPcmWaitMs = Math.max(this.diagnostics.maxPcmWaitMs, elapsed);
      if (elapsed > 20) this.diagnostics.deadlineMissCount++;
      if (elapsed > Math.max(20, duration)) this.diagnostics.latePullCount++;
    }
  }

  private enqueue(output: Uint8Array, frames: number): void {
    this.controller.enqueue(output.subarray(0, frames * this.frameBytes));
    this.diagnostics.emittedFrames += frames;
  }
}

export default PlaybackMixer;
