import { EventEmitter } from "eventemitter3";
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
  InputSource,
} from "../Types/index.js";
import { FluentAudioState } from "./FluentAudioState.js";

export default class FluentStream extends EventEmitter {
  static readonly HUMANITY_HEADERS = HUMANITY_HEADERS;

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
      typeof options.headers === "object" && options.headers !== null
        ? options.headers
        : undefined;
    this.logger = options.logger ?? DEFAULT_LOGGER;

    const ap = options.audioProcessorOptions;
    this.audio = new FluentAudioState({
      volume: ap?.volume,
      bass: ap?.bass,
      treble: ap?.treble,
      compressor: ap?.compressor,
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

  private createProcessor(
    extraOpts: Partial<ProcessorOptions> = {},
  ): Processor {
    const mergedHeaders = this.getMergedHeaders();
    const ap = this.options.audioProcessorOptions;
    const finalOptions: ProcessorOptions = {
      ...this.options,
      ...extraOpts,
      headers: mergedHeaders,
      useAudioProcessor: this.audio.enabled,
      audioProcessorOptions: this.audio.buildOptions(
        ap?.sampleRate,
        ap?.channels,
      ),
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

  public setCompressor(enabled: boolean): this {
    this.audio.setCompressor(enabled);
    return this;
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
          this.emitLog(
            "warn",
            `input(): Duplicate URL input detected: "${input}"`,
            {
              code: "FluentStream-duplicate-url-input",
            },
          );
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
        this.emitLog(
          "warn",
          `input(): Duplicate string input detected: "${input}"`,
          {
            code: "FluentStream-duplicate-string-input",
          },
        );
        return this;
      }

      this.args.push("-i", input);
      return this;
    }

    let isReadableStream = typeof (input as any).getReader === "function";
    let isNodeReadable =
      typeof (input as any).on === "function" &&
      typeof (input as any).pipe === "function";

    if (isNodeReadable && !isReadableStream) {
      const nodeStream = input as any;
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          nodeStream.on("data", (chunk: any) => {
            const bytes =
              chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            controller.enqueue(bytes);
          });
          nodeStream.on("end", () => controller.close());
          nodeStream.on("error", (err: any) => controller.error(err));
        },
        cancel(reason) {
          if (typeof nodeStream.destroy === "function") {
            nodeStream.destroy(reason);
          }
        },
      });
      input = webStream;
      isReadableStream = true;
    }

    if (isReadableStream) {
      let streamIdx: number;

      if (
        opts?.pipeIndex != null &&
        Number.isFinite(opts.pipeIndex) &&
        opts.pipeIndex >= 0
      ) {
        if (this.inputStreams.some((entry) => entry.index === opts.pipeIndex)) {
          throw new FluentStreamValidationError(
            `input(): Duplicate pipe index: ${opts.pipeIndex}`,
          );
        }
        streamIdx = opts.pipeIndex;
      } else {
        streamIdx = this.inputStreams.length;
      }

      if (
        !opts?.allowDuplicate &&
        this.inputStreams.some((s) => s.stream === input)
      ) {
        this.emitLog(
          "warn",
          "input(): Duplicate Readable stream detected (skipped)",
          {
            code: "FluentStream-duplicate-pipe",
          },
        );
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
    output:
      | string
      | ReadableStream<Uint8Array>
      | number
      | { pipe?: string }
      | undefined
      | null,
  ): this {
    this.requireClean("output");
    if (
      output &&
      typeof output === "object" &&
      "pipe" in output &&
      output.pipe
    ) {
      const pipeName = output.pipe;

      if (
        pipeName === "stdout" ||
        pipeName === "stderr" ||
        pipeName === "1" ||
        pipeName === "2"
      ) {
        const pipeTarget =
          pipeName === "stdout" || pipeName === "1" ? "pipe:1" : "pipe:2";
        this.args.push(pipeTarget);
        return this;
      }

      if (typeof pipeName === "string" && /^pipe:\d+$/.test(pipeName)) {
        this.args.push(pipeName);
        return this;
      }

      throw new FluentStreamValidationError(
        `output(): Invalid pipe target: ${String(pipeName)}`,
      );
    }

    if (
      output == null ||
      (typeof output === "string" && output.trim().length === 0)
    ) {
      throw new FluentStreamValidationError(
        "output(): requires non-empty string or pipe object",
      );
    }

    this.args.push(String(output));
    return this;
  }

  public getHeaders(): Record<string, string> {
    return this.getMergedHeaders();
  }

  public setHeaders(
    headers?: Record<string, string> | null,
    opts?: { merge?: boolean },
  ): this {
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
      if (
        this.args[i] === "-user_agent" &&
        typeof this.args[i + 1] === "string"
      ) {
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
          v === "-i" &&
          typeof arr[idx + 1] === "string" &&
          /^https?:\/\//.test(arr[idx + 1]!),
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
    if (
      position == null ||
      (typeof position === "string" && !position.trim())
    ) {
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
    if (
      this.args.some((_v, i, arr) => arr[i] === "-c" && arr[i + 1] === "copy")
    ) {
      return this;
    }
    this.args.push("-c", "copy");
    return this;
  }

  public crossfadeAudio(
    durationSec: number,
    options: CrossfadeAudioOptions = {},
  ): this {
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
        const already = this.args.some(
          (v, i) => v === "-i" && this.args[i + 1] === second,
        );
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
      throw new FluentStreamValidationError(
        "inputBlob(): blobUrl must be a non-empty string",
      );
    }

    const inputIndex = index ?? this.inputSources.length;
    this.inputSources.push({ type: "blob", blobUrl, index: inputIndex });
    this.args.push("-i", `pipe:${inputIndex}`);

    return this;
  }

  public clear(): this {
    this.args = [];
    this.inputStreams = [];
    this.inputSources = [];
    this.complexFilters = [];
    this.isDirty = false;
    this.processorResult = null;
    return this;
  }

  public resetArgs(): this {
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

    if (
      typeof this.options.wallTimeLimit === "number" &&
      this.options.wallTimeLimit > 0
    ) {
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
    return summarizeInputs(
      this.args,
      this.inputStreams,
      this.complexFilters,
      this.inputSources,
    );
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
  public async run(
    extraOpts: Partial<ProcessorOptions> = {},
  ): Promise<FFmpegRunResultExtended> {
    if (this.isDirty) {
      throw new FluentStreamValidationError(
        "FluentStream is dirty — you cannot call `.run()` multiple times on the same configuration. " +
          "Call `.clear()` to reset the builder state before the next execution.",
      );
    }
    const processor = this.createProcessor(extraOpts);
    this.isDirty = true;
    const result = await processor.run();
    this.processorResult = result;
    this.audio.attachResult(result);

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
      compressor: boolean;
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
        compressor: this.audio.compressor,
        audioProcessor: this.audio.enabled,
      },
    };
  }
}
