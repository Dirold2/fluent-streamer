import { MiniEmitter } from "hemmiter";
import Processor from "../Core/Processor.js";
import { HUMANITY_HEADERS, DEFAULT_LOGGER } from "./constants.js";
import { FluentStreamValidationError } from "./errors.js";
import { getStackTrace, countInputs, summarizeInputs } from "./utils.js";

import type {
  FFmpegRunResultExtended,
  ProcessorOptions,
  Logger,
  LogMeta,
  CrossfadeAudioOptions,
  LiveCrossfadeOptions,
  InputSource,
  FFmpegProgress,
} from "../Types/index.js";
import { PlaybackMixer, validateLiveCrossfadeOptions } from "../Audio/PlaybackMixer.js";
import { buildReturningAtempo } from "../Audio/analysis/Atempo.js";
import { FluentAudioState } from "./FluentAudioState.js";
import { analyzeTrack, type DjAnalysis } from "../Audio/analysis/DjAnalysis.js";
import {
  planAutomix,
  type AutomixPlan,
  type AutomixDiagnostic,
} from "../Audio/analysis/AutomixPlan.js";
import type { PreparedMixerInput } from "../Audio/PlaybackMixer.js";

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
  static readonly HUMANITY_HEADERS = HUMANITY_HEADERS;

  private outputTargets: string[] = [];
  private args: string[] = [];
  private inputStreams: Array<{
    stream: ReadableStream<Uint8Array>;
    index: number;
  }> = [];
  private inputSources: InputSource[] = [];
  private complexFilters: string[] = [];
  public readonly options: ProcessorOptions;
  private headers: Record<string, string> | undefined;
  private isDirty = false;

  private audio: FluentAudioState;

  private logger: Logger;
  private processorResult: FFmpegRunResultExtended | null = null;
  private seekInProgress = false;
  private playback?: {
    mixer: PlaybackMixer;
    active: FFmpegRunResultExtended;
    result: FFmpegRunResultExtended;
    originMs: number;
  };
  private crossfadeInProgress = false;
  private automixCancellation?: () => void;
  private lastRunOptions: Partial<ProcessorOptions> = {};

  public get volume(): number {
    return this.audio.volume;
  }
  public set volume(value: number) {
    this.audio.setVolume(value);
  }

  public get bass(): number {
    return this.audio.bass;
  }
  public set bass(value: number) {
    this.audio.setBass(value);
  }

  public get treble(): number {
    return this.audio.treble;
  }
  public set treble(value: number) {
    this.audio.setTreble(value);
  }

  public get mids(): number {
    return this.audio.mids;
  }
  public set mids(value: number) {
    this.audio.setMids(value);
  }

  public get compressor(): boolean {
    return this.audio.compressor;
  }
  public set compressor(value: boolean) {
    this.audio.setCompressor(value);
  }

  public get useAudioProcessor(): boolean {
    return this.audio.enabled;
  }
  public set useAudioProcessor(value: boolean) {
    this.audio.enable(value);
  }

  constructor(options: ProcessorOptions = {}) {
    super();
    this.options = { ...options };
    this.headers =
      typeof options.headers === "object" && options.headers !== null ? options.headers : undefined;
    this.logger = options.logger ?? DEFAULT_LOGGER;

    const ap = options.audioProcessorOptions;
    this.audio = new FluentAudioState({
      volume: ap?.volume,
      bass: ap?.bass,
      treble: ap?.treble,
      mids: ap?.mids,
      compressor: ap?.compressor,
      karaoke: ap?.karaoke,
      enabled: options.useAudioProcessor ?? false,
      sampleRate: ap?.sampleRate,
      channels: ap?.channels,
    });
  }

  private emitLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: LogMeta,
  ): void {
    const fullMeta = { ...meta };
    if (!fullMeta.stackTrace) {
      fullMeta.stackTrace = getStackTrace();
    }
    if (typeof this.logger[level] === "function") {
      this.logger[level](message, fullMeta);
    }
  }

  private getMergedHeaders(): Record<string, string> {
    if (!this.headers || Object.keys(this.headers).length === 0) {
      return { ...HUMANITY_HEADERS };
    }
    return { ...this.headers };
  }

  private createProcessor(extraOpts: Partial<ProcessorOptions> = {}): Processor {
    const mergedHeaders = this.getMergedHeaders();
    const ap = this.options.audioProcessorOptions;
    const finalOptions: ProcessorOptions = {
      ...this.options,
      ...extraOpts,
      headers: mergedHeaders,
      useAudioProcessor: this.audio.enabled,
      audioProcessorOptions: {
        ...this.audio.buildOptions(ap?.sampleRate, ap?.channels),
        normalize: extraOpts.audioProcessorOptions?.normalize ?? false,
      },
      inputStreams: this.inputStreams,
      inputSources: this.inputSources,
    };

    const processor = Processor.create({
      options: finalOptions,
      args: this.assembleArgs(),
      inputStreams: this.inputStreams,
    });
    processor.setInputSources(this.inputSources);
    return processor;
  }

  private requireClean(operation: string): void {
    if (this.isDirty) {
      throw new FluentStreamValidationError(
        `Cannot use .${operation}() after .run() without .clear()`,
      );
    }
  }

  public setVolume(value: number): this {
    this.audio.setVolume(value);
    return this;
  }

  public fadeIn(targetVolume: number = 1, durationMs: number = 1000): this {
    this.audio.fadeIn(targetVolume, durationMs);
    return this;
  }

  public fadeOut(durationMs: number = 1000): this {
    this.audio.fadeOut(durationMs);
    return this;
  }

  public setBass(value: number): this {
    this.audio.setBass(value);
    return this;
  }

  public setTreble(value: number): this {
    this.audio.setTreble(value);
    return this;
  }

  public setMids(value: number): this {
    this.audio.setMids(value);
    return this;
  }

  public setCompressor(enabled: boolean): this {
    this.audio.setCompressor(enabled);
    return this;
  }

  public get karaoke(): boolean {
    return this.audio.karaoke;
  }
  public set karaoke(value: boolean) {
    this.audio.setKaraoke(value);
  }

  public setKaraoke(enabled: boolean): this {
    this.audio.setKaraoke(enabled);
    return this;
  }

  public changeKaraoke(enabled: boolean): boolean {
    return this.audio.changeKaraoke(enabled);
  }

  public enableAudioProcessing(enable: boolean = true): this {
    this.audio.enable(enable);
    return this;
  }

  public changeVolume(value: number): boolean {
    return this.audio.changeVolume(value);
  }

  public changeBass(value: number): boolean {
    return this.audio.changeBass(value);
  }

  public changeTreble(value: number): boolean {
    return this.audio.changeTreble(value);
  }

  public changeMids(value: number): boolean {
    return this.audio.changeMids(value);
  }

  public changeCompressor(enabled: boolean): boolean {
    return this.audio.changeCompressor(enabled);
  }

  public changeNormalize(enabled: boolean): boolean {
    return this.audio.changeNormalize(enabled);
  }

  public input(
    input:
      | string
      | ReadableStream<Uint8Array>
      | { on: (...args: any[]) => any; pipe: (...args: any[]) => any }
      | undefined
      | null,
    opts?: {
      label?: string;
      pipeIndex?: number;
      allowDuplicate?: boolean;
    },
  ): this {
    this.requireClean("input");
    if (input == null) {
      throw new FluentStreamValidationError(
        "input(): input must be non-null string (path/URL/blob) or Readable stream",
      );
    }

    if (typeof input === "string") {
      if (input.startsWith("blob:")) {
        return this.inputBlob(input, opts?.pipeIndex);
      }

      if (/^https?:\/\//i.test(input)) {
        if (
          !opts?.allowDuplicate &&
          this.inputSources.some((s) => s.type === "url" && s.url === input)
        ) {
          this.emitLog("warn", `input(): Duplicate URL input detected: "${input}"`, {
            code: "FluentStream-duplicate-url-input",
          });
          return this;
        }
        const index = this.inputSources.length;
        this.inputSources.push({ type: "url", url: input, index });
        return this;
      }

      if (
        !opts?.allowDuplicate &&
        this.args.some((v, i) => v === "-i" && this.args[i + 1] === input)
      ) {
        this.emitLog("warn", `input(): Duplicate string input detected: "${input}"`, {
          code: "FluentStream-duplicate-string-input",
        });
        return this;
      }

      this.args.push("-i", input);
      return this;
    }

    let isReadableStream = typeof (input as any).getReader === "function";
    let isNodeReadable =
      typeof (input as any).on === "function" && typeof (input as any).pipe === "function";

    if (isNodeReadable && !isReadableStream) {
      const nodeStream = input as any;
      let settled = false;
      let cleanup = () => {};
      const webStream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            const onData = (chunk: any) => {
              if (settled) return;
              try {
                const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                controller.enqueue(bytes);
                if (controller.desiredSize! <= 0) nodeStream.pause();
              } catch (error) {
                onError(error);
                nodeStream.destroy();
              }
            };
            const onEnd = () => {
              if (settled) return;
              settled = true;
              cleanup();
              controller.close();
            };
            const onError = (error: unknown) => {
              if (settled) return;
              settled = true;
              nodeStream.pause();
              nodeStream.removeListener("data", onData);
              nodeStream.removeListener("end", onEnd);
              controller.error(error);
            };
            const onClose = () => {
              if (!settled) {
                onError(new Error("Node readable closed before ending"));
              }
              cleanup();
            };
            cleanup = () => {
              nodeStream.removeListener("data", onData);
              nodeStream.removeListener("end", onEnd);
              nodeStream.removeListener("error", onError);
              nodeStream.removeListener("close", onClose);
            };
            nodeStream.pause();
            nodeStream.on("end", onEnd);
            nodeStream.on("error", onError);
            nodeStream.on("close", onClose);
            nodeStream.on("data", onData);
            if (nodeStream.errored) onError(nodeStream.errored);
            else if (nodeStream.readableEnded) onEnd();
            else if (nodeStream.destroyed) onClose();
          },
          pull() {
            if (!settled) nodeStream.resume();
          },
          cancel(reason) {
            settled = true;
            nodeStream.pause();
            // Keep error/close listeners until destroy completes, including custom _destroy errors.
            nodeStream.destroy(reason instanceof Error ? reason : undefined);
          },
        },
        { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
      );
      input = webStream;
      isReadableStream = true;
    }

    if (isReadableStream) {
      let streamIdx: number;

      if (opts?.pipeIndex != null && Number.isFinite(opts.pipeIndex) && opts.pipeIndex >= 0) {
        if (this.inputStreams.some((entry) => entry.index === opts.pipeIndex)) {
          throw new FluentStreamValidationError(`input(): Duplicate pipe index: ${opts.pipeIndex}`);
        }
        streamIdx = opts.pipeIndex;
      } else {
        streamIdx = this.inputStreams.length;
      }

      if (!opts?.allowDuplicate && this.inputStreams.some((s) => s.stream === input)) {
        this.emitLog("warn", "input(): Duplicate Readable stream detected (skipped)", {
          code: "FluentStream-duplicate-pipe",
        });
        return this;
      }

      this.inputStreams.push({
        stream: input as ReadableStream<Uint8Array>,
        index: streamIdx,
      });
      this.args.push("-i", `pipe:${streamIdx}`);
    } else {
      throw new FluentStreamValidationError(
        "input(): must be string (file/URL/blob) or Readable stream",
      );
    }

    return this;
  }

  public output(
    output: string | ReadableStream<Uint8Array> | number | { pipe?: string } | undefined | null,
  ): this {
    this.requireClean("output");
    if (output && typeof output === "object" && "pipe" in output && output.pipe) {
      const pipeName = output.pipe;

      if (pipeName === "stdout" || pipeName === "stderr" || pipeName === "1" || pipeName === "2") {
        const pipeTarget = pipeName === "stdout" || pipeName === "1" ? "pipe:1" : "pipe:2";
        this.outputTargets.push(pipeTarget);
        this.args.push(pipeTarget);
        return this;
      }

      if (typeof pipeName === "string" && /^pipe:\d+$/.test(pipeName)) {
        this.outputTargets.push(pipeName);
        this.args.push(pipeName);
        return this;
      }

      throw new FluentStreamValidationError(`output(): Invalid pipe target: ${String(pipeName)}`);
    }

    if (output == null || (typeof output === "string" && output.trim().length === 0)) {
      throw new FluentStreamValidationError("output(): requires non-empty string or pipe object");
    }

    this.outputTargets.push(String(output));
    this.args.push(String(output));
    return this;
  }

  public getHeaders(): Record<string, string> {
    return this.getMergedHeaders();
  }

  public setHeaders(headers?: Record<string, string> | null, opts?: { merge?: boolean }): this {
    this.requireClean("setHeaders");
    if (headers == null) {
      this.headers = undefined;
    } else if (!opts?.merge) {
      this.headers = headers;
    } else {
      this.headers = { ...this.headers, ...headers };
    }

    return this;
  }

  public userAgent(userAgent?: string | null): this {
    this.requireClean("userAgent");
    for (let i = 0; i < this.args.length;) {
      if (this.args[i] === "-user_agent" && typeof this.args[i + 1] === "string") {
        this.args.splice(i, 2);
      } else {
        i++;
      }
    }

    if (userAgent && userAgent.length > 0) {
      const firstInput = this.args.findIndex((a) => a === "-i");
      if (firstInput !== -1) {
        this.args.splice(firstInput, 0, "-user_agent", userAgent);
      } else {
        this.args.unshift("-user_agent", userAgent);
      }

      const hasHTTPInput = this.args.some(
        (v, idx, arr) =>
          v === "-i" && typeof arr[idx + 1] === "string" && /^https?:\/\//.test(arr[idx + 1]!),
      );

      if (!hasHTTPInput) {
        this.emitLog(
          "warn",
          "userAgent: applies ONLY to HTTP/HTTPS inputs. FFmpeg will ignore it for other protocols.",
          { code: "FluentStream-non-http-useragent" },
        );
      }
    }

    return this;
  }

  public inputOptions(...opts: string[]): this {
    this.requireClean("inputOptions");
    const idx = this.args.lastIndexOf("-i");
    if (idx !== -1) {
      this.args.splice(idx, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }

    return this;
  }

  public outputOptions(...opts: string[]): this {
    this.args.push(...opts);
    return this;
  }

  public globalOptions(...opts: string[]): this {
    const firstInput = this.args.findIndex((a) => a === "-i");
    if (firstInput !== -1) {
      this.args.splice(firstInput, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  public audioCodec(codec: string): this {
    if (codec) {
      this.args.push("-c:a", codec);
    }
    return this;
  }

  public videoCodec(codec: string): this {
    if (codec) {
      this.args.push("-c:v", codec);
    }
    return this;
  }

  public audioFrequency(frequency: number): this {
    this.args.push("-ar", String(frequency));
    return this;
  }

  public audioChannels(channels: number): this {
    this.args.push("-ac", String(channels));
    return this;
  }

  public format(fmt: string): this {
    for (let i = 0; i < this.args.length - 1;) {
      if (this.args[i] === "-f") {
        this.args.splice(i, 2);
      } else {
        i++;
      }
    }
    this.args.push("-f", fmt);
    return this;
  }

  public noVideo(): this {
    this.args.push("-vn");
    return this;
  }

  public noAudio(): this {
    this.args.push("-an");
    return this;
  }

  public complexFilter(graph: string | string[]): this {
    this.requireClean("complexFilter");
    if (Array.isArray(graph)) {
      for (const g of graph) {
        if (typeof g === "string" && g.trim()) {
          this.complexFilters.push(g);
        }
      }
    } else if (typeof graph === "string" && graph.trim()) {
      this.complexFilters.push(graph);
    }

    return this;
  }

  public map(spec: string): this {
    this.args.push("-map", spec);
    return this;
  }

  public seekInput(position: number | string): this {
    this.requireClean("seekInput");
    if (position == null || (typeof position === "string" && !position.trim())) {
      throw new FluentStreamValidationError(
        "seekInput: position must be non-empty string or number",
      );
    }

    const firstInput = this.args.findIndex((a) => a === "-i");
    if (firstInput === -1) {
      this.args.unshift("-ss", String(position));
    } else {
      this.args.splice(firstInput, 0, "-ss", String(position));
    }

    return this;
  }

  /** Seek to an absolute position. Mixed playback retains its output; ordinary runs return a replacement. */
  public async seek(position: number | string): Promise<FFmpegRunResultExtended> {
    if (this.seekInProgress)
      throw new FluentStreamValidationError("seek: another seek is in progress");
    const seconds = typeof position === "number" ? position : this.parseSeekPosition(position);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new FluentStreamValidationError(
        "seek: position must be a finite non-negative number of seconds or HH:MM:SS timestamp",
      );
    }
    if (this.crossfadeInProgress)
      throw new FluentStreamValidationError("seek: wait for the active crossfade to finish");
    if (this.playback) return this.seekMixedPlayback(seconds);
    const previous = this.processorResult;
    if (!previous) throw new FluentStreamValidationError("seek: no active run");
    const inputs = this.args.flatMap((arg, i) => (arg === "-i" ? [this.args[i + 1]!] : []));
    const urls = this.inputSources.filter((source) => source.type === "url");
    if (
      this.inputStreams.length ||
      this.inputSources.some((source) => source.type !== "url") ||
      inputs.length + urls.length !== 1 ||
      inputs.some((input) => /^(pipe:|\/dev\/stdin|-\s*$)/.test(input)) ||
      this.complexFilters.length ||
      this.args.includes("-filter_complex") ||
      this.args[this.args.length - 1] !== "pipe:1"
    ) {
      throw new FluentStreamValidationError(
        "seek: requires a single replayable file/URL input and a single stdout output; stream/blob inputs and complex filters are unsupported",
      );
    }
    const globalOptions = this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? [];
    if (
      globalOptions.includes("-i") ||
      this.outputTargets.length !== 1 ||
      this.outputTargets[0] !== "pipe:1"
    ) {
      throw new FluentStreamValidationError(
        "seek: requires a single stdout output and no additional global inputs",
      );
    }
    const abortSignal = this.lastRunOptions.abortSignal ?? this.options.abortSignal;
    abortSignal?.throwIfAborted();
    this.seekInProgress = true;
    const savedArgs = [...this.args];
    const options = { ...this.lastRunOptions };
    const ap = previous.audioProcessor;
    // Result setters can bypass FluentAudioState, so capture the live DSP values.
    if (ap) {
      this.audio.setVolume(ap.volume);
      this.audio.setBass(ap.bass * 20);
      this.audio.setMids(ap.mids * 20);
      this.audio.setTreble(ap.treble * 20);
      this.audio.setCompressor(ap.compressor);
      this.audio.setKaraoke(ap.karaoke);
    }
    const normalize = ap?.normalize ?? false;
    try {
      await previous.stop();
      await previous.done.catch(() => {});
      this.args = savedArgs.filter((arg, i) => arg !== "-ss" && savedArgs[i - 1] !== "-ss");
      const globalArgs = [...(options.extraGlobalArgs ?? this.options.extraGlobalArgs ?? [])];
      const cleanGlobal = globalArgs.filter(
        (arg, i) => arg !== "-ss" && globalArgs[i - 1] !== "-ss",
      );
      if (urls.length) {
        options.extraGlobalArgs = [...cleanGlobal, "-ss", String(seconds)];
      } else {
        const index = this.args.indexOf("-i");
        this.args.splice(index, 0, "-ss", String(seconds));
        options.extraGlobalArgs = cleanGlobal;
      }
      abortSignal?.throwIfAborted();
      options.audioProcessorOptions = { ...this.audio.buildOptions(), normalize };
      this.isDirty = false;
      const result = await this.run(options);
      result.setNormalize?.(normalize);
      return result;
    } finally {
      this.seekInProgress = false;
    }
  }

  /** Switch the mixer to a restarted decoder without closing the session output. */
  private async seekMixedPlayback(seconds: number): Promise<FFmpegRunResultExtended> {
    const session = this.playback!;
    const abortSignal = this.lastRunOptions.abortSignal ?? this.options.abortSignal;
    abortSignal?.throwIfAborted();
    const release = session.mixer.hold();
    this.seekInProgress = true;
    let next: FFmpegRunResultExtended | undefined;
    let mixerOwnsNext = false;
    try {
      const ap = session.active.audioProcessor;
      if (ap) {
        this.audio.setVolume(ap.volume);
        this.audio.setBass(ap.bass * 20);
        this.audio.setMids(ap.mids * 20);
        this.audio.setTreble(ap.treble * 20);
        this.audio.setCompressor(ap.compressor);
        this.audio.setKaraoke(ap.karaoke);
      }
      const args = this.args.filter((arg, i) => arg !== "-ss" && this.args[i - 1] !== "-ss");
      args.splice(args.indexOf("-i"), 0, "-ss", String(seconds));
      const globalArgs = this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? [];
      const processor = this.createProcessor({
        ...this.lastRunOptions,
        extraGlobalArgs: globalArgs.filter(
          (arg, i) => arg !== "-ss" && globalArgs[i - 1] !== "-ss",
        ),
        autoDrainOutput: false,
        audioProcessorOptions: { ...this.audio.buildOptions(), normalize: ap?.normalize ?? false },
      });
      processor.setArgs(args);
      next = await processor.run();
      const incoming = next;
      void incoming.done.catch(() => {});
      abortSignal?.throwIfAborted();
      if (this.playback !== session) throw new Error("seek: playback stopped");
      const transition = session.mixer.seek(
        incoming.output,
        0.02,
        Object.assign(
          async () => {
            await incoming.stop("SIGKILL");
            await incoming.done;
          },
          { prepare: (reason: unknown) => processor.prepareOutputCancellation(reason) },
        ),
      );
      mixerOwnsNext = true;
      release();
      await transition;
      if (this.playback !== session) throw new Error("seek: playback stopped");
      session.active = incoming;
      this.audio.attachResult(incoming);
      this.args = args;
      session.originMs = seconds * 1000;
      return session.result;
    } catch (error) {
      if (next && !mixerOwnsNext) {
        await next.stop("SIGKILL");
        await next.done.catch(() => {});
      }
      throw error;
    } finally {
      release();
      this.seekInProgress = false;
    }
  }

  private parseSeekPosition(position: string): number {
    if (typeof position !== "string" || !/^(?:\d+:){0,2}\d+(?:\.\d+)?$/.test(position.trim()))
      return NaN;
    return position
      .trim()
      .split(":")
      .reduce((total, part) => total * 60 + Number(part), 0);
  }

  public duration(time: number | string): this {
    this.args.push("-t", String(time));
    return this;
  }

  public audioBitrate(bitrate: string): this {
    this.args.push("-b:a", bitrate);
    return this;
  }

  public videoBitrate(bitrate: string): this {
    this.args.push("-b:v", bitrate);
    return this;
  }

  public overwrite(): this {
    this.args = this.args.filter((a) => a !== "-y");
    this.args.unshift("-y");
    return this;
  }

  public copyCodecs(): this {
    if (this.args.some((_v, i, arr) => arr[i] === "-c" && arr[i + 1] === "copy")) {
      return this;
    }
    this.args.push("-c", "copy");
    return this;
  }

  private logCrossfade(
    stage: "preparing" | "mixing" | "completed" | "failed",
    durationSeconds: number,
    started: number,
  ): void {
    if (!(this.lastRunOptions.verbose ?? this.options.verbose)) return;
    const logger = this.lastRunOptions.logger ?? this.logger;
    const tag = this.lastRunOptions.loggerTag ?? this.options.loggerTag ?? "FluentStream";
    // Do not log source URLs: they can contain credentials or signed query parameters.
    try {
      const level = stage === "failed" ? "error" : "debug";
      logger[level](`[${tag}] Crossfade ${stage}`, {
        code: `FluentStream-crossfade-${stage}`,
        detail: { durationSeconds, elapsedMs: performance.now() - started },
      });
    } catch {
      // A diagnostic sink must not interrupt playback or decoder cleanup.
    }
  }

  /** Transition immediately to another file/URL without replacing the PCM output. */
  public async crossfade(url: string, time = 3, options: LiveCrossfadeOptions = {}): Promise<void> {
    const session = this.playback;
    if (!session)
      throw new FluentStreamValidationError("crossfade: run with enableCrossfade: true first");
    if (this.seekInProgress)
      throw new FluentStreamValidationError("crossfade: seek is in progress");
    if (this.crossfadeInProgress)
      throw new FluentStreamValidationError("crossfade: transition already active");
    if (typeof url !== "string" || !url.trim() || /^(pipe:|blob:)/.test(url) || url === "-")
      throw new FluentStreamValidationError("crossfade: expected a replayable file/URL");
    if (!Number.isFinite(time) || time < 0 || time > 3600)
      throw new FluentStreamValidationError("crossfade: time must be 0..3600 seconds");
    validateLiveCrossfadeOptions(options);
    options = { ...options };
    const release = session.mixer.hold();
    this.crossfadeInProgress = true;
    const started = performance.now();
    let next: FFmpegRunResultExtended | undefined;
    let mixerOwnsNext = false;
    try {
      this.logCrossfade("preparing", time, started);
      const ap = session.active.audioProcessor;
      if (ap) {
        this.audio.setVolume(ap.volume);
        this.audio.setBass(ap.bass * 20);
        this.audio.setMids(ap.mids * 20);
        this.audio.setTreble(ap.treble * 20);
        this.audio.setCompressor(ap.compressor);
        this.audio.setKaraoke(ap.karaoke);
      }
      const args = [...this.args];
      const index = args.indexOf("-i");
      args[index + 1] = url;
      const clean = args.filter((arg, i) => arg !== "-ss" && args[i - 1] !== "-ss");
      if (options.startTime !== undefined)
        clean.splice(clean.indexOf("-i"), 0, "-ss", String(options.startTime));
      const globalArgs = this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? [];
      const processor = this.createProcessor({
        ...this.lastRunOptions,
        extraGlobalArgs: globalArgs.filter(
          (arg, i) => arg !== "-ss" && globalArgs[i - 1] !== "-ss",
        ),
        autoDrainOutput: false,
        audioProcessorOptions: { ...this.audio.buildOptions(), normalize: ap?.normalize ?? false },
      });
      processor.setArgs(clean);
      next = await processor.run();
      const incoming = next;
      void incoming.done.catch(() => {});
      if (this.playback !== session) throw new Error("crossfade: playback stopped");
      const transition = session.mixer.crossfade(
        incoming.output,
        time,
        Object.assign(
          async () => {
            await incoming.stop("SIGKILL");
            await incoming.done;
          },
          { prepare: (reason: unknown) => processor.prepareOutputCancellation(reason) },
        ),
        options,
      );
      mixerOwnsNext = true;
      release();
      this.logCrossfade("mixing", time, started);
      await transition;
      if (this.playback === session) {
        session.active = incoming;
        this.audio.attachResult(incoming);
        this.args = clean;
        session.originMs = (options.startTime ?? 0) * 1000;
        this.logCrossfade("completed", time, started);
      }
    } catch (error) {
      this.logCrossfade("failed", time, started);
      if (next && !mixerOwnsNext) {
        await next.stop("SIGKILL");
        await next.done.catch(() => {});
      }
      throw error;
    } finally {
      release();
      this.crossfadeInProgress = false;
    }
  }

  /**
   * Analyze and prebuffer without starting a transition. Decoder configuration and
   * effects are snapshotted at preparation time; later setters affect only the
   * active decoder until the prepared track becomes active. No EOF hold is taken.
   */
  /** Current PCM generation diagnostics, or null outside a mixed playback session. */
  public getPlaybackStats() {
    return this.playback?.mixer.stats ?? null;
  }

  public async prepareAutomix(
    url: string,
    options: PrepareAutomixOptions,
  ): Promise<PreparedAutomix> {
    const session = this.playback;
    if (!session)
      throw new FluentStreamValidationError("prepareAutomix: run with enableCrossfade: true first");
    if (this.seekInProgress || this.crossfadeInProgress)
      throw new FluentStreamValidationError("prepareAutomix: seek or transition already active");
    if (
      typeof url !== "string" ||
      !url.trim() ||
      /^(pipe:|blob:)/.test(url) ||
      url === "-" ||
      url === "/dev/stdin"
    )
      throw new FluentStreamValidationError("prepareAutomix: expected a replayable file/URL");
    options = { ...options };
    if (
      options.transitionMode !== undefined &&
      options.transitionMode !== "crossfade" &&
      options.transitionMode !== "beat-handoff"
    )
      throw new FluentStreamValidationError("prepareAutomix: invalid transitionMode");
    const args = [...this.args];
    const globalArgs = [
      ...(this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? []),
    ];
    const rate = this.options.audioProcessorOptions?.sampleRate ?? 48000;
    const initialFrame = session.mixer.sourceFrame;
    const originMs = session.originMs;
    const controller = new AbortController();
    const signals = [options.signal, this.lastRunOptions.abortSignal ?? this.options.abortSignal];
    const abort = () => {
      // Once mixer-owned, retire through its cancellation protocol before killing
      // the decoder; its startup signal must not error the still-locked PCM output.
      if (state === "ready") void cancel().catch(() => {});
      else if (state === "preparing")
        controller.abort(new Error("prepareAutomix: aborted or playback stopped"));
    };
    let next: FFmpegRunResultExtended | undefined;
    let owned = false;
    let prepareOutputCancellation: ((reason: unknown) => void) | undefined;
    let token: PreparedMixerInput | undefined;
    let state: "preparing" | "ready" | "started" | "cancelled" = "preparing";
    let cancellation: Promise<void> | undefined;
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    void aborted.catch(() => {});
    const detach = () => {
      for (const signal of signals) signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const unlock = () => {
      detach();
      if (this.automixCancellation === abort) {
        this.automixCancellation = undefined;
        this.crossfadeInProgress = false;
      }
    };
    const cancel = (): Promise<void> => {
      if (cancellation) return cancellation;
      if (state === "started") return Promise.reject(new Error("prepareAutomix: already started"));
      state = "cancelled";
      cancellation = (async () => {
        try {
          if (token && this.playback === session) await session.mixer.discardPrepared(token);
        } finally {
          unlock();
        }
      })();
      return cancellation;
    };
    const onAbort = () => {
      prepareOutputCancellation?.(controller.signal.reason);
      rejectAborted(controller.signal.reason);
      if (state === "ready") void cancel().catch(() => {});
      else if (next && state === "preparing") {
        prepareOutputCancellation?.(controller.signal.reason);
        void Promise.resolve(next.stop("SIGKILL")).catch(() => {});
      }
    };
    this.crossfadeInProgress = true;
    this.automixCancellation = abort;
    controller.signal.addEventListener("abort", onAbort);
    for (const signal of signals) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
    try {
      controller.signal.throwIfAborted();
      const ap = session.active.audioProcessor;
      if (ap) {
        this.audio.setVolume(ap.volume);
        this.audio.setBass(ap.bass * 20);
        this.audio.setMids(ap.mids * 20);
        this.audio.setTreble(ap.treble * 20);
        this.audio.setCompressor(ap.compressor);
        this.audio.setKaraoke(ap.karaoke);
      }
      const clean = args.filter((arg, i) => arg !== "-ss" && args[i - 1] !== "-ss");
      clean[clean.indexOf("-i") + 1] = url;
      const processor = this.createProcessor({
        ...this.lastRunOptions,
        extraGlobalArgs: globalArgs.filter(
          (arg, i) => arg !== "-ss" && globalArgs[i - 1] !== "-ss",
        ),
        autoDrainOutput: false,
        abortSignal: controller.signal,
        audioProcessorOptions: { ...this.audio.buildOptions(), normalize: ap?.normalize ?? false },
      });
      prepareOutputCancellation = (reason) => processor.prepareOutputCancellation(reason);
      const analysisOptions = {
        ffmpegPath: this.lastRunOptions.ffmpegPath ?? this.options.ffmpegPath,
        timeout: this.lastRunOptions.timeout ?? this.options.timeout,
        headers: this.getMergedHeaders(),
        signal: controller.signal,
      };
      const [outgoingAnalysis, incomingAnalysis] = await Promise.race([
        Promise.all([
          options.outgoingAnalysis ?? analyzeTrack(args[args.indexOf("-i") + 1]!, analysisOptions),
          options.incomingAnalysis ?? analyzeTrack(url, analysisOptions),
        ]),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      if (this.playback !== session) throw new Error("prepareAutomix: playback stopped");
      const frame = session.mixer.sourceFrame;
      const tempoFactor =
        options.transitionOverride?.tempoFactor ??
        (options.enableTempoMatch && outgoingAnalysis.bpm && incomingAnalysis.bpm
          ? outgoingAnalysis.bpm / incomingAnalysis.bpm
          : 1);
      const maxTempoChange = options.maxTempoChange ?? 0.08;
      if (
        !Number.isFinite(maxTempoChange) ||
        maxTempoChange < 0 ||
        maxTempoChange >= 1 ||
        (options.enableTempoMatch && Math.abs(tempoFactor - 1) > maxTempoChange)
      ) {
        throw new FluentStreamValidationError(
          "prepareAutomix: tempo correction exceeds maxTempoChange",
        );
      }
      if (
        options.transitionOverride &&
        (!Number.isFinite(options.transitionOverride.cueMs) ||
          options.transitionOverride.cueMs < 0 ||
          !Number.isFinite(options.transitionOverride.seconds) ||
          options.transitionOverride.seconds <= 0 ||
          (options.transitionOverride.startMs !== undefined &&
            (!Number.isFinite(options.transitionOverride.startMs) ||
              options.transitionOverride.startMs < originMs + (frame / rate) * 1000 ||
              options.transitionOverride.startMs + options.transitionOverride.seconds * 1000 >
                originMs + (initialFrame / rate) * 1000 + options.outgoingRemainingMs - 1000)))
      ) {
        throw new FluentStreamValidationError("prepareAutomix: invalid transitionOverride");
      }
      const plan = options.transitionOverride
        ? {
            seconds: options.transitionOverride.seconds,
            cueMs: options.transitionOverride.cueMs,
            dropMs: null,
            reason: "tempo-phrase" as const,
            startMs:
              options.transitionOverride.startMs ??
              originMs +
                (frame / rate) * 1000 +
                Math.max(
                  0,
                  options.outgoingRemainingMs -
                    ((frame - initialFrame) / rate) * 1000 -
                    options.transitionOverride.seconds * 1000 -
                    1000,
                ),
            beatPeriodMs: null,
          }
        : planAutomix({
            outgoingAnalysis,
            incomingAnalysis,
            outgoingPositionMs: originMs + (frame / rate) * 1000,
            outgoingRemainingMs:
              options.outgoingRemainingMs - ((frame - initialFrame) / rate) * 1000,
            incomingDurationMs: options.incomingDurationMs,
            fallbackSeconds: options.fallbackSeconds ?? 8,
            explicitDropMs: options.explicitDropMs,
            enableTempoMatch: options.enableTempoMatch,
            maxTempoChange,
            onDiagnostic: (diagnostic) => {
              try {
                options.onDiagnostic?.(diagnostic);
              } catch {
                /* Diagnostics must not interrupt preparation. */
              }
              if (!(this.lastRunOptions.verbose ?? this.options.verbose)) return;
              const logger = this.lastRunOptions.logger ?? this.logger;
              const tag = this.lastRunOptions.loggerTag ?? this.options.loggerTag ?? "FluentStream";
              try {
                logger.debug(`[${tag}] Automix decision`, {
                  code: "FluentStream-automix-decision",
                  detail: diagnostic,
                });
              } catch {
                /* Logger failures must not affect the plan. */
              }
            },
          });
      if (!plan)
        throw new FluentStreamValidationError(
          "prepareAutomix: insufficient remaining time or invalid timing",
        );
      const frozenPlan = Object.freeze({ ...plan });
      clean.splice(clean.indexOf("-i"), 0, "-ss", String(plan.cueMs / 1000));
      if (options.enableTempoMatch && Math.abs(tempoFactor - 1) > 1e-12) {
        const tempoFilter = buildReturningAtempo(tempoFactor, plan.seconds);
        const filterIndex = clean.lastIndexOf("-af");
        if (filterIndex >= 0 && filterIndex + 1 < clean.length) {
          clean[filterIndex + 1] = `${clean[filterIndex + 1]},${tempoFilter}`;
        } else {
          const outputIndex = clean.lastIndexOf("pipe:1");
          if (outputIndex < 0)
            throw new FluentStreamValidationError("prepareAutomix: missing PCM output");
          clean.splice(outputIndex, 0, "-af", tempoFilter);
        }
      }
      processor.setArgs(clean);
      const startup = processor.run().then(async (result) => {
        void result.done.catch(() => {});
        if (controller.signal.aborted) {
          processor.prepareOutputCancellation(controller.signal.reason);
          await result.stop("SIGKILL");
          await result.done.catch(() => {});
          throw controller.signal.reason;
        }
        return result;
      });
      next = await Promise.race([startup, aborted]);
      const incoming = next;
      void incoming.done.catch(() => {});
      controller.signal.throwIfAborted();
      if (this.playback !== session) throw new Error("prepareAutomix: playback stopped");
      // prepare takes ownership synchronously, including cleanup on prefetch failure.
      owned = true;
      token = await session.mixer.prepare(
        incoming.output,
        Object.assign(
          async () => {
            await incoming.stop("SIGKILL");
            await incoming.done;
          },
          { prepare: (reason: unknown) => processor.prepareOutputCancellation(reason) },
        ),
      );
      controller.signal.throwIfAborted();
      if (this.playback !== session) throw new Error("prepareAutomix: playback stopped");
      state = "ready";
      return {
        plan: frozenPlan,
        cancel,
        start: async () => {
          if (state !== "ready") throw new Error("prepareAutomix: already started or cancelled");
          if (this.playback !== session) {
            await cancel();
            throw new Error("prepareAutomix: playback stopped");
          }
          controller.signal.throwIfAborted();
          const currentFrame = session.mixer.sourceFrame;
          let startFrame = Math.max(0, Math.round(((plan.startMs - originMs) / 1000) * rate));
          const beatPeriodFrames =
            plan.beatPeriodMs === null
              ? undefined
              : Math.max(1, Math.round((plan.beatPeriodMs / 1000) * rate));
          if (beatPeriodFrames && currentFrame > startFrame)
            startFrame +=
              Math.ceil((currentFrame - startFrame) / beatPeriodFrames) * beatPeriodFrames;
          const endFrame = initialFrame + (options.outgoingRemainingMs / 1000) * rate;
          // The incoming cue is already decoded, so do not silently change the plan.
          // Preserve the planner's one-second outgoing tail even after late arming.
          if (
            Math.max(currentFrame, startFrame) + Math.round(plan.seconds * rate) >
            endFrame - rate
          ) {
            await cancel();
            throw new FluentStreamValidationError(
              "prepareAutomix: prepared plan is stale; insufficient remaining time",
            );
          }
          state = "started";
          detach();
          try {
            await session.mixer.crossfadePrepared(
              token!,
              plan.seconds,
              {
                ...(options.transitionMode === "beat-handoff"
                  ? { mode: "beat-handoff" as const }
                  : {}),
                curve: "equalPower",
                outgoingBassDb: -12,
                bassHandoff: true,
                headroomDb: 3,
              },
              {
                startFrame,
                ...(beatPeriodFrames === undefined ? {} : { beatPeriodFrames }),
              },
            );
            if (this.playback !== session) throw new Error("prepareAutomix: playback stopped");
            session.active = incoming;
            this.audio.attachResult(incoming);
            // Tempo commands belong only to this decoder. Future seeks/replays
            // use the original filter chain at native speed, not a second ramp.
            this.args = args.filter((arg, i) => arg !== "-ss" && args[i - 1] !== "-ss");
            this.args[this.args.indexOf("-i") + 1] = url;
            this.args.splice(this.args.indexOf("-i"), 0, "-ss", String(plan.cueMs / 1000));
            session.originMs = plan.cueMs;
          } finally {
            unlock();
          }
        },
      };
    } catch (error) {
      controller.abort(error);
      try {
        if (token && this.playback === session) await session.mixer.discardPrepared(token);
        else if (next && !owned) {
          await next.stop("SIGKILL");
          await next.done.catch(() => {});
        }
      } finally {
        unlock();
      }
      throw error;
    }
  }

  private validateMixedPlayback(): void {
    const value = (flag: string) => this.args[this.args.lastIndexOf(flag) + 1];
    if (
      this.inputSources.length ||
      this.inputStreams.length ||
      this.complexFilters.length ||
      this.args.includes("-filter_complex") ||
      this.args.filter((a) => a === "-i").length !== 1 ||
      this.outputTargets.length !== 1 ||
      this.outputTargets[0] !== "pipe:1" ||
      this.args[this.args.length - 1] !== "pipe:1" ||
      value("-f") !== "s16le" ||
      (value("-c:a") !== "pcm_s16le" && value("-acodec") !== "pcm_s16le")
    )
      throw new FluentStreamValidationError(
        "enableCrossfade requires one .input(file/URL), pcm_s16le, -f s16le and one stdout output; no complex filters",
      );
    const source = this.args[this.args.indexOf("-i") + 1]!;
    if (/^(pipe:|blob:)/.test(source) || source === "-" || source === "/dev/stdin")
      throw new FluentStreamValidationError("enableCrossfade: input must be a replayable file/URL");
    const ap = this.options.audioProcessorOptions;
    if (
      Number(value("-ar")) !== (ap?.sampleRate ?? 48000) ||
      Number(value("-ac")) !== (ap?.channels ?? 2)
    )
      throw new FluentStreamValidationError(
        "enableCrossfade: explicitly set -ar/-ac matching audioProcessorOptions (default 48000/2)",
      );
    const global = this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? [];
    if (global.includes("-i"))
      throw new FluentStreamValidationError("enableCrossfade: extra global inputs unsupported");
  }

  public crossfadeAudio(durationSec: number, options: CrossfadeAudioOptions = {}): this {
    this.requireClean("crossfadeAudio");
    if (
      durationSec == null ||
      typeof durationSec !== "number" ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0
    ) {
      throw new FluentStreamValidationError(
        "crossfadeAudio: durationSec must be a positive number",
      );
    }

    if (options.secondInput) {
      const second = options.secondInput;

      if (typeof second === "string") {
        const already = this.args.some((v, i) => v === "-i" && this.args[i + 1] === second);
        if (!already) {
          this.input(second);
        }
      } else {
        this.input(second, { allowDuplicate: false });
      }
    }

    const counted = this.countInputs();
    const inputs = options.inputs ?? 2;

    if (counted.total < inputs) {
      throw new FluentStreamValidationError(
        `crossfadeAudio: requires at least ${inputs} inputs, but only ${counted.total} configured`,
      );
    }

    const { filter } = Processor.buildAcrossfadeFilter({
      inputs,
      duration: durationSec,
      curve1: options.curve1 ?? "tri",
      curve2: options.curve2 ?? "tri",
      inputLabels: options.inputLabels,
      outputLabel: options.outputLabel,
    });

    if (options.extra && String(options.extra).trim().length > 0) {
      const extraFilter = String(options.extra).trim();
      const outputLbl = options.outputLabel ?? "acf";
      const finalFilter = `${filter};[${outputLbl}]${extraFilter}[${outputLbl}_final]`;
      this.complexFilter(finalFilter);
    } else {
      this.complexFilter(filter);
    }

    return this;
  }

  public inputBlob(blobUrl: string, index?: number): this {
    this.requireClean("inputBlob");
    if (!blobUrl || typeof blobUrl !== "string") {
      throw new FluentStreamValidationError("inputBlob(): blobUrl must be a non-empty string");
    }

    const inputIndex = index ?? this.inputSources.length;
    this.inputSources.push({ type: "blob", blobUrl, index: inputIndex });
    this.args.push("-i", `pipe:${inputIndex}`);

    return this;
  }

  public clear(): this {
    if (this.playback) throw new FluentStreamValidationError("Stop mixed playback before clear");
    if (this.seekInProgress) throw new FluentStreamValidationError("Cannot clear during seek");
    this.outputTargets = [];
    this.args = [];
    this.inputStreams = [];
    this.inputSources = [];
    this.complexFilters = [];
    this.isDirty = false;
    this.processorResult = null;
    return this;
  }

  public resetArgs(): this {
    if (this.playback)
      throw new FluentStreamValidationError("Stop mixed playback before resetArgs");
    if (this.seekInProgress)
      throw new FluentStreamValidationError("Cannot reset arguments during seek");
    this.outputTargets = [];
    this.args = [];
    this.complexFilters = [];
    return this;
  }

  public isDirtyState(): boolean {
    return this.isDirty;
  }

  public isReady(): boolean {
    return !this.isDirty;
  }

  public getArgs(): string[] {
    return [...this.args];
  }

  public assembleArgs(): string[] {
    const finalArgs = [...this.args];
    if (this.complexFilters.length > 0) {
      let hasFilterComplex = false;

      for (let i = 0; i < finalArgs.length - 1; i++) {
        if (finalArgs[i] === "-filter_complex") {
          hasFilterComplex = true;
          this.emitLog(
            "warn",
            "assembleArgs: Duplicate -filter_complex detected. Using combined filters.",
            { code: "FluentStream-duplicate-filter-complex" },
          );
          break;
        }
      }

      if (!hasFilterComplex) {
        finalArgs.push("-filter_complex", this.complexFilters.join(";"));
      }
    }

    if (this.options.failFast && !finalArgs.includes("-xerror")) {
      finalArgs.push("-xerror");
    }

    if (this.options.enableProgressTracking) {
      if (!finalArgs.some((v, _i, _arr) => v === "-progress")) {
        finalArgs.push("-progress", "pipe:2");
      }
    }

    if (typeof this.options.wallTimeLimit === "number" && this.options.wallTimeLimit > 0) {
      finalArgs.push("-timelimit", String(this.options.wallTimeLimit));
    }

    return finalArgs;
  }

  public getInputSummary(): {
    stringInputs: string[];
    urlInputs: string[];
    pipeStreams: string[];
    complexFilters: string[];
  } {
    return summarizeInputs(this.args, this.inputStreams, this.complexFilters, this.inputSources);
  }

  public countInputs(): {
    streams: number;
    stringInputs: number;
    urlInputs: number;
    total: number;
  } {
    return countInputs(this.args, this.inputStreams, this.inputSources);
  }

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
  public async run(extraOpts: Partial<ProcessorOptions> = {}): Promise<FFmpegRunResultExtended> {
    if (this.isDirty) {
      throw new FluentStreamValidationError(
        "FluentStream is dirty — you cannot call `.run()` multiple times on the same configuration. " +
          "Call `.clear()` to reset the builder state before the next execution.",
      );
    }
    this.lastRunOptions = { ...extraOpts };
    const mixed = extraOpts.enableCrossfade ?? this.options.enableCrossfade ?? false;
    if (mixed) this.validateMixedPlayback();
    const processor = this.createProcessor(
      mixed ? { ...extraOpts, autoDrainOutput: false } : extraOpts,
    );
    this.isDirty = true;
    const result = await processor.run();
    if (mixed) {
      const mixer = new PlaybackMixer(
        result.output,
        this.options.audioProcessorOptions?.sampleRate ?? 48000,
        this.options.audioProcessorOptions?.channels ?? 2,
        Object.assign(
          async () => {
            await result.stop("SIGKILL");
            await result.done;
          },
          { prepare: (reason: unknown) => processor.prepareOutputCancellation(reason) },
        ),
      );
      const publicResult: FFmpegRunResultExtended = {
        ...result,
        output: mixer.output,
        passthrough: mixer.output,
        done: mixer.done,
        stop: () => {
          if (this.playback?.mixer === mixer) this.automixCancellation?.();
          return mixer.stop();
        },
        close: () => {
          if (this.playback?.mixer === mixer) this.automixCancellation?.();
          return mixer.stop();
        },
        seek: (position) => {
          if (this.playback?.result !== publicResult)
            return Promise.reject(
              new FluentStreamValidationError("seek: this session is no longer active"),
            );
          return this.seek(position);
        },
        crossfade: (url, time, options) => {
          if (this.playback?.result !== publicResult)
            return Promise.reject(
              new FluentStreamValidationError("crossfade: this session is no longer active"),
            );
          return this.crossfade(url, time, options);
        },
      };
      const originArgs = [
        ...(this.lastRunOptions.extraGlobalArgs ?? this.options.extraGlobalArgs ?? []),
        ...this.args,
      ];
      const seekIndex = originArgs.lastIndexOf("-ss");
      const originMs =
        seekIndex < 0 ? 0 : this.parseSeekPosition(originArgs[seekIndex + 1]!) * 1000;
      const session = { mixer, active: result, result: publicResult, originMs };
      this.playback = session;
      for (const key of [
        "setVolume",
        "setBass",
        "setMids",
        "setTreble",
        "setCompressor",
        "setNormalize",
        "setKaraoke",
        "startFade",
      ] as const) {
        Object.defineProperty(publicResult, key, { get: () => session.active[key] });
      }
      Object.defineProperty(publicResult, "audioProcessor", {
        get: () => session.active.audioProcessor,
      });
      void result.done.catch(() => {});
      this.processorResult = publicResult;
      this.audio.attachResult(result);
      const clear = () => {
        if (this.playback === session) {
          this.playback = undefined;
          this.automixCancellation?.();
          this.processorResult = null;
          this.audio.attachResult(null);
        }
      };
      mixer.done.then(clear, clear);
      return publicResult;
    }
    this.processorResult = result;
    this.audio.attachResult(result);
    result.seek = (position) => {
      if (this.processorResult !== result)
        return Promise.reject(
          new FluentStreamValidationError("seek: this run is no longer active"),
        );
      return this.seek(position);
    };

    const clearProcessorResult = () => {
      if (this.processorResult === result) {
        this.processorResult = null;
        this.audio.attachResult(null);
      }
    };
    result.done.then(clearProcessorResult, clearProcessorResult);

    await new Promise((resolve) => setTimeout(resolve, 50));

    return result;
  }

  static get stdout(): { pipe: string } {
    return { pipe: "stdout" };
  }

  static get stderr(): { pipe: string } {
    return { pipe: "stderr" };
  }

  static get pipe1(): { pipe: "pipe:1" } {
    return { pipe: "pipe:1" };
  }

  static get pipe2(): { pipe: "pipe:2" } {
    return { pipe: "pipe:2" };
  }

  public toString(): string {
    return (
      `[FluentStream dirty=${this.isDirty}` +
      `inputs=${this.countInputs().total}` +
      `filters=${this.complexFilters.length}` +
      `args=${this.args.length}]`
    );
  }

  public debugInfo(): {
    isDirty: boolean;
    args: string[];
    inputs: Array<{ stream: string; index: number }>;
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
  } {
    return {
      isDirty: this.isDirty,
      args: [...this.args],
      inputs: this.inputStreams.map((s) => ({
        stream: `Readable[${s.index}]`,
        index: s.index,
      })),
      filters: [...this.complexFilters],
      audioState: {
        volume: this.audio.volume,
        bass: this.audio.bass,
        treble: this.audio.treble,
        mids: this.audio.mids,
        compressor: this.audio.compressor,
        karaoke: this.audio.karaoke,
        audioProcessor: this.audio.enabled,
      },
    };
  }
}
