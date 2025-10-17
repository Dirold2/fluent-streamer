/**
 * Fluent wrapper around the low-level Processor providing a chainable API
 * to build FFmpeg arguments and optionally attach input streams.
 */
import { EventEmitter } from "eventemitter3";
import { type Readable, Transform } from "stream";
import { existsSync, lstatSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname } from "path";
import os from "os";
import { type AudioPlugin, type AudioPluginOptions } from "./Filters";
import Processor from "./Processor";
import { type SimpleFFmpegOptions, type FFmpegRunResult } from "src/Types";

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
export class FluentStream extends EventEmitter {
  private args: string[] = [];
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private inputFiles: string[] = [];
  private readonly options: Required<SimpleFFmpegOptions>;
  private pendingFifos: string[] = [];
  private audioTransformConfig?: {
    transform: Transform;
    sampleRate: number;
    channels: number;
    buildEncoder: (enc: FluentStream) => void;
  };
  private audioPluginConfig?: {
    plugin: AudioPlugin;
    options: Required<AudioPluginOptions>;
    buildEncoder: (enc: FluentStream) => void;
  };

  /**
   * Create a new fluent builder.
   * @param options - default configuration for created Processor
   */
  constructor(options: SimpleFFmpegOptions = {}) {
    super();
    this.options = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      failFast: options.failFast ?? false,
      extraGlobalArgs: options.extraGlobalArgs ?? [],
      loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
      enableProgressTracking: options.enableProgressTracking ?? false,
      logger: options.logger ?? console,
    } as Required<SimpleFFmpegOptions>;

    if (this.options.failFast) this.args.push("-xerror");
    if (this.options.extraGlobalArgs?.length)
      this.args.push(...this.options.extraGlobalArgs);
    if (this.options.enableProgressTracking)
      this.args.push("-progress", "pipe:2");
  }

  // ================= Fluent API =================
  /**
   * Insert global options (appear before any inputs), e.g. "-hide_banner".
   */
  globalOptions(...opts: string[]) {
    this.args.unshift(...opts);
    return this;
  }
  /**
   * Insert options that must precede the last input (e.g. "-f lavfi").
   */
  inputOptions(...opts: string[]) {
    const lastInputIndex = this.args.lastIndexOf("-i");
    if (lastInputIndex !== -1) {
      this.args.splice(lastInputIndex, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  /**
   * Add an input source (filepath or stream). Streams are piped via stdin.
   */
  input(input: string | Readable) {
    if (typeof input === "string") {
      this.args.push("-i", input);
      this.inputFiles.push(input);
    } else {
      const index = this.inputStreams.length;
      this.inputStreams.push({ stream: input, index });
      this.args.push("-i", "pipe:0");
    }
    return this;
  }

  /**
   * Add a named pipe (FIFO) as an input. The FIFO will be created at run() time if missing.
   * This allows позднее подмешивание второго трека: ffmpeg ждёт, пока вы начнёте писать в FIFO.
   */
  inputFifo(fifoPath: string) {
    this.pendingFifos.push(fifoPath);
    this.args.push("-i", fifoPath);
    return this;
  }

  /**
   * Prepare a FIFO path and register it as the next input automatically.
   * @returns absolute FIFO path
   */
  prepareNextTrackFifo(options?: { dir?: string; prefix?: string }): string {
    const dir = options?.dir ?? os.tmpdir();
    const prefix = options?.prefix ?? "ffmpeg_fifo";
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const path = `${dir}/${prefix}_${unique}.fifo`;
    this.inputFifo(path);
    return path;
  }

  output(output: string) {
    this.args.push(output);
    return this;
  }
  /** Add output options (appended near the end, before output). */
  outputOptions(...opts: string[]) {
    this.args.push(...opts);
    return this;
  }
  videoCodec(codec: string) {
    this.args.push("-c:v", codec);
    return this;
  }
  audioCodec(codec: string) {
    this.args.push("-c:a", codec);
    return this;
  }
  videoBitrate(bitrate: string) {
    this.args.push("-b:v", bitrate);
    return this;
  }
  audioBitrate(bitrate: string) {
    this.args.push("-b:a", bitrate);
    return this;
  }
  size(size: string) {
    this.args.push("-s", size);
    return this;
  }
  fps(fps: number) {
    this.args.push("-r", fps.toString());
    return this;
  }
  duration(duration: string | number) {
    this.args.push("-t", duration.toString());
    return this;
  }
  seek(time: string | number) {
    this.args.push("-ss", time.toString());
    return this;
  }
  format(format: string) {
    this.args.push("-f", format);
    return this;
  }
  overwrite() {
    this.args.push("-y");
    return this;
  }
  noOverwrite() {
    this.args.push("-n");
    return this;
  }

  /**
   * Add a custom complex filter string.
   * Example: .complexFilter('[0:a][1:a]acrossfade=d=5:c1=tri:c2=tri[aout]')
   */
  complexFilter(filterGraph: string) {
    this.args.push("-filter_complex", filterGraph);
    return this;
  }

  /**
   * Map a specific stream label to output (e.g., '[aout]' or '[vout]').
   */
  map(label: string) {
    this.args.push("-map", label);
    return this;
  }

  /**
   * Audio crossfade helper using FFmpeg acrossfade filter.
   * Crossfades audio from inputA to inputB for duration seconds.
   * Note: requires at least two inputs. By default uses [0:a] and [1:a].
   */
  crossfadeAudio(
    durationSeconds: number,
    options?: {
      inputA?: number;
      inputB?: number;
      curve1?: string;
      curve2?: string;
    },
  ) {
    const inputA = options?.inputA ?? 0;
    const inputB = options?.inputB ?? 1;
    const c1 = options?.curve1 ?? "tri";
    const c2 = options?.curve2 ?? "tri";
    const graph = `[${inputA}:a][${inputB}:a]acrossfade=d=${durationSeconds}:c1=${c1}:c2=${c2}[aout]`;
    this.args.push("-filter_complex", graph, "-map", "[aout]");
    return this;
  }

  /**
   * Enable JS audio processing between decode and encode stages.
   * You provide a Transform (e.g., your AudioProcessor) and a builder to configure the encoder stage.
   * The decoder stage is generated automatically to produce PCM s16le at the given rate/channels.
   */
  withAudioTransform(
    transform: Transform,
    buildEncoder: (enc: FluentStream) => void,
    opts?: { sampleRate?: number; channels?: number },
  ) {
    this.audioTransformConfig = {
      transform,
      sampleRate: opts?.sampleRate ?? 48000,
      channels: opts?.channels ?? 2,
      buildEncoder,
    };
    return this;
  }

  /**
   * Plug-in style audio processing. The plugin returns a Transform; we wire it as withAudioTransform.
   */
  withAudioPlugin(
    plugin: AudioPlugin,
    buildEncoder: (enc: FluentStream) => void,
    opts?: AudioPluginOptions,
  ) {
    this.audioPluginConfig = {
      plugin,
      options: {
        sampleRate: opts?.sampleRate ?? 48000,
        channels: opts?.channels ?? 2,
      },
      buildEncoder,
    };
    return this;
  }

  // ================= Execute via Processor =================
  /**
   * Execute using the low-level Processor. Subscribes to Processor events
   * and re-emits them from the wrapper instance.
   */
  run(): FFmpegRunResult {
    // Ensure any declared FIFOs exist synchronously before spawning ffmpeg
    for (const fifoPath of this.pendingFifos) {
      this.ensureFifoSync(fifoPath);
    }
    // If plugin is provided, construct transform from plugin
    if (this.audioPluginConfig && !this.audioTransformConfig) {
      const t = this.audioPluginConfig.plugin.createTransform(
        this.audioPluginConfig.options,
      );
      const { sampleRate, channels } = this.audioPluginConfig.options;
      return this.withAudioTransform(t, this.audioPluginConfig.buildEncoder, {
        sampleRate,
        channels,
      }).run();
    }

    // If JS audio transform is enabled, run decode -> transform -> encode chain
    if (this.audioTransformConfig) {
      const { transform, sampleRate, channels, buildEncoder } =
        this.audioTransformConfig;

      // Build decoder args (inputs -> PCM s16le pipe)
      const decoder = new Processor({
        ffmpegPath: this.options.ffmpegPath,
        failFast: this.options.failFast,
        extraGlobalArgs: this.options.extraGlobalArgs,
        enableProgressTracking: this.options.enableProgressTracking,
        logger: this.options.logger as any,
      });

      const decoderArgs: string[] = [];
      // inputs from files/fifos
      for (const f of this.inputFiles) decoderArgs.push("-i", f);
      for (const f of this.pendingFifos) decoderArgs.push("-i", f);
      // support single stream input
      if (this.inputStreams.length > 0) decoderArgs.push("-i", "pipe:0");
      // decode to PCM s16le
      decoderArgs.push(
        "-vn",
        "-ac",
        String(channels),
        "-ar",
        String(sampleRate),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "pipe:1",
      );

      if (this.inputStreams.length > 0)
        decoder.setInputStreams([this.inputStreams[0]]);
      decoder.setArgs(decoderArgs);

      const { output: decodedPcm, done: decodeDone } = decoder.run();

      // Build encoder args via provided builder
      const encoderBuilder = new FluentStream({
        ffmpegPath: this.options.ffmpegPath,
        failFast: this.options.failFast,
        extraGlobalArgs: this.options.extraGlobalArgs,
        enableProgressTracking: this.options.enableProgressTracking,
        logger: this.options.logger as any,
      });
      buildEncoder(encoderBuilder);
      const encoderArgsTail = encoderBuilder.getArgs();

      const encoder = new Processor({
        ffmpegPath: this.options.ffmpegPath,
        failFast: this.options.failFast,
        extraGlobalArgs: this.options.extraGlobalArgs,
        enableProgressTracking: this.options.enableProgressTracking,
        logger: this.options.logger as any,
      });

      // input is PCM from transform
      const encoderArgs: string[] = [
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "-i",
        "pipe:0",
        ...encoderArgsTail,
      ];
      encoder.setArgs(encoderArgs);
      encoder.setInputStreams([
        { stream: transform as unknown as Readable, index: 0 },
      ]);

      // Wire: decoder -> transform -> encoder
      decodedPcm.pipe(transform);

      // Bubble events
      decoder.on("start", (cmd) => this.emit("start", cmd));
      decoder.on("spawn", (d) => this.emit("spawn", d));
      decoder.on("progress", (p) => this.emit("progress", p));
      decoder.on("error", (e) => this.emit("error", e as any));
      decoder.on("terminated", (s) => this.emit("terminated", s));

      const { output, done } = encoder.run();
      encoder.on("start", (cmd) => this.emit("start", cmd));
      encoder.on("spawn", (d) => this.emit("spawn", d));
      encoder.on("progress", (p) => this.emit("progress", p));
      encoder.on("error", (e) => this.emit("error", e as any));
      encoder.on("terminated", (s) => this.emit("terminated", s));

      // Ensure decoder completion propagates if encoder finishes first
      decodeDone.catch((e) => this.emit("error", e as any));

      return { output, done };
    }

    const processor = new Processor({
      ffmpegPath: this.options.ffmpegPath,
      failFast: this.options.failFast,
      extraGlobalArgs: this.options.extraGlobalArgs,
      enableProgressTracking: this.options.enableProgressTracking,
      logger: this.options.logger as any,
    });

    // Bubble up events
    processor.on("spawn", (data) => this.emit("spawn", data));
    processor.on("start", (cmd) => this.emit("start", cmd));
    processor.on("progress", (p) => this.emit("progress", p));
    processor.on("end", () => this.emit("end"));
    processor.on("terminated", (s) => this.emit("terminated", s));
    processor.on("error", (e) => this.emit("error", e as any));

    processor.setArgs(this.args);
    if (this.inputStreams.length > 0)
      processor.setInputStreams(this.inputStreams);
    return processor.run();
  }

  // ================= Utilities =================
  /** Get a copy of the constructed args. */
  getArgs(): string[] {
    return [...this.args];
  }
  /** Get full command string preview. */
  toString(): string {
    return `${this.options.ffmpegPath} ${this.args.join(" ")}`;
  }
  /** Get current input streams. */
  getInputStreams(): Array<{ stream: Readable; index: number }> {
    return this.inputStreams;
  }

  private ensureFifoSync(filePath: string) {
    try {
      if (existsSync(filePath)) {
        const stat = lstatSync(filePath);
        if (!stat.isFIFO())
          throw new Error(`Path exists but is not FIFO: ${filePath}`);
        return;
      }
      mkdirSync(dirname(filePath), { recursive: true });
      const res = spawnSync("mkfifo", ["-m", "600", filePath], {
        stdio: "ignore",
      });
      if (res.status !== 0) throw new Error(`mkfifo failed for ${filePath}`);
    } catch (e) {
      throw new Error(
        `Failed to ensure FIFO at ${filePath}: ${(e as Error).message}`,
      );
    }
  }
}

export { FluentStream as default };
