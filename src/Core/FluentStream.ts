/**
 * @class FluentStream
 * @classdesc
 * FluentStream is a fluent, chainable wrapper around the low-level Processor for building FFmpeg command arguments and optionally attaching input streams.
 *
 * Provides an ergonomic builder API for constructing FFmpeg commands,
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
import { existsSync, lstatSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname } from "path";
import os from "os";
import { type AudioPlugin, type AudioPluginOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";
import { FluentChain } from "./FluentChain.js";
import Processor from "./Processor.js";
import {
  type SimpleFFmpegOptions,
  type FFmpegRunResult,
} from "../Types/index.js";

/**
 * @class SimpleFFmpeg
 * @classdesc
 * SimpleFFmpeg provides a convenient, chainable interface for constructing FFmpeg commands. It delegates execution to the low-level Processor.
 *
 * @example
 * const ff = new SimpleFFmpeg({ enableProgressTracking: true })
 *   .input('input.mp4')
 *   .videoCodec('libx264')
 *   .output('pipe:1');
 * const { output, done } = ff.run();
 */
export class FluentStream extends EventEmitter {
  // =============== Global Plugin Registry (static) ===============
  private static _globalRegistry: PluginRegistry | null = null;

  /** Get or create the global plugin registry singleton */
  private static get globalRegistry(): PluginRegistry {
    if (!this._globalRegistry) this._globalRegistry = new PluginRegistry();
    return this._globalRegistry;
  }

  /** Register a plugin globally (preferred API surface) */
  static registerPlugin(
    name: string,
    factory: (options: Required<AudioPluginOptions>) => AudioPlugin,
  ): void {
    this.globalRegistry.register(name, factory);
  }

  /** Check if a plugin is registered globally */
  static hasPlugin(name: string): boolean {
    return this.globalRegistry.has(name);
  }

  /** Clear global plugins (intended for tests) */
  static clearPlugins(): void {
    this._globalRegistry = new PluginRegistry();
  }
  private args: string[] = [];
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private inputFiles: string[] = [];
  private readonly options: Required<SimpleFFmpegOptions>;
  private pendingFifos: string[] = [];
  public audioTransformConfig?: {
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
   * Create a new FluentStream builder.
   *
   * @param {SimpleFFmpegOptions} [options] - Default configuration for the created Processor.
   *
   * @example
   * const ff = new FluentStream({ enableProgressTracking: true });
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
   * Set global FFmpeg options (prepended to command).
   * @param {...string} opts
   * @returns {FluentStream}
   */
  globalOptions(...opts: string[]): FluentStream {
    this.args.unshift(...opts);
    return this;
  }

  /**
   * Set input options (inserted before last input).
   * @param {...string} opts
   * @returns {FluentStream}
   */
  inputOptions(...opts: string[]): FluentStream {
    const lastInputIndex = this.args.lastIndexOf("-i");
    if (lastInputIndex !== -1) {
      this.args.splice(lastInputIndex, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  /**
   * Add an input (filename or Readable stream).
   * @param {string|Readable} input
   * @returns {FluentStream}
   */
  input(input: string | Readable): FluentStream {
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
   * Add a named pipe FIFO as input.
   * @param {string} fifoPath
   * @returns {FluentStream}
   */
  inputFifo(fifoPath: string): FluentStream {
    this.pendingFifos.push(fifoPath);
    this.args.push("-i", fifoPath);
    return this;
  }

  /**
   * Generate a new FIFO path in a temp directory and add as an input.
   * @param {{dir?: string, prefix?: string}} [options]
   * @returns {string} Absolute FIFO path
   */
  prepareNextTrackFifo(options?: { dir?: string; prefix?: string }): string {
    const dir = options?.dir ?? os.tmpdir();
    const prefix = options?.prefix ?? "ffmpeg_fifo";
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const path = `${dir}/${prefix}_${unique}.fifo`;
    this.inputFifo(path);
    return path;
  }

  /**
   * Set output destination (filename, 'pipe:1', etc.).
   * @param {string} output
   * @returns {FluentStream}
   */
  output(output: string): FluentStream {
    this.args.push(output);
    return this;
  }

  /**
   * Add options for output.
   * @param {...string} opts
   * @returns {FluentStream}
   */
  outputOptions(...opts: string[]): FluentStream {
    this.args.push(...opts);
    return this;
  }

  /**
   * Specify video codec.
   * @param {string} codec
   * @returns {FluentStream}
   */
  videoCodec(codec: string): FluentStream {
    this.args.push("-c:v", codec);
    return this;
  }

  /**
   * Specify audio codec.
   * @param {string} codec
   * @returns {FluentStream}
   */
  audioCodec(codec: string): FluentStream {
    this.args.push("-c:a", codec);
    return this;
  }

  /**
   * Set video bitrate.
   * @param {string} bitrate
   * @returns {FluentStream}
   */
  videoBitrate(bitrate: string): FluentStream {
    this.args.push("-b:v", bitrate);
    return this;
  }

  /**
   * Set audio bitrate.
   * @param {string} bitrate
   * @returns {FluentStream}
   */
  audioBitrate(bitrate: string): FluentStream {
    this.args.push("-b:a", bitrate);
    return this;
  }

  /**
   * Set output video size.
   * @param {string} size
   * @returns {FluentStream}
   */
  size(size: string): FluentStream {
    this.args.push("-s", size);
    return this;
  }

  /**
   * Set framerate.
   * @param {number} fps
   * @returns {FluentStream}
   */
  fps(fps: number): FluentStream {
    this.args.push("-r", fps.toString());
    return this;
  }

  /**
   * Set output duration.
   * @param {string|number} duration
   * @returns {FluentStream}
   */
  duration(duration: string | number): FluentStream {
    this.args.push("-t", duration.toString());
    return this;
  }

  /**
   * Set input seek time.
   * @param {string|number} time
   * @returns {FluentStream}
   */
  seek(time: string | number): FluentStream {
    this.args.push("-ss", time.toString());
    return this;
  }

  /**
   * Set output format.
   * @param {string} format
   * @returns {FluentStream}
   */
  format(format: string): FluentStream {
    this.args.push("-f", format);
    return this;
  }

  /**
   * Enable overwrite output files.
   * @returns {FluentStream}
   */
  overwrite(): FluentStream {
    this.args.push("-y");
    return this;
  }

  /**
   * Disable overwrite output files.
   * @returns {FluentStream}
   */
  noOverwrite(): FluentStream {
    this.args.push("-n");
    return this;
  }

  /**
   * Add a complex filtergraph.
   * @param {string} filterGraph
   * @returns {FluentStream}
   */
  complexFilter(filterGraph: string): FluentStream {
    this.args.push("-filter_complex", filterGraph);
    return this;
  }

  /**
   * Select FFmpeg output stream label.
   * @param {string} label
   * @returns {FluentStream}
   */
  map(label: string): FluentStream {
    this.args.push("-map", label);
    return this;
  }

  /**
   * Add an audio crossfade filter. Output is mapped to '[aout]'.
   * @param {number} durationSeconds
   * @param {{inputA?: number, inputB?: number, curve1?: string, curve2?: string}} [options]
   * @returns {FluentStream}
   */
  crossfadeAudio(
    durationSeconds: number,
    options?: {
      inputA?: number;
      inputB?: number;
      curve1?: string;
      curve2?: string;
    },
  ): FluentStream {
    const inputA = options?.inputA ?? 0;
    const inputB = options?.inputB ?? 1;
    const c1 = options?.curve1 ?? "tri";
    const c2 = options?.curve2 ?? "tri";
    const graph = `[${inputA}:a][${inputB}:a]acrossfade=d=${durationSeconds}:c1=${c1}:c2=${c2}[aout]`;
    this.args.push("-filter_complex", graph, "-map", "[aout]");
    return this;
  }

  /**
   * Attach a JS Transform stream to process PCM data between decode and encode. Only one FFmpeg process is spawned with transform inserted in the chain.
   *
   * @param {Transform} transform - Node.js transform stream
   * @param {function(FluentStream):void} buildEncoder - Callback to set codecs/output after transform
   * @param {{sampleRate?: number, channels?: number}} [opts] - Audio stream settings
   * @returns {FluentStream}
   */
  withAudioTransform(
    transform: Transform,
    buildEncoder: (enc: FluentStream) => void,
    opts?: { sampleRate?: number; channels?: number },
  ): FluentStream {
    this.audioTransformConfig = {
      transform,
      sampleRate: opts?.sampleRate ?? 48000,
      channels: opts?.channels ?? 2,
      buildEncoder,
    };

    // Remove all "-i pipe:0" except the first (rightmost)
    let firstPipeIndex = -1;
    for (let i = this.args.length - 1; i >= 0; --i) {
      if (this.args[i] === "-i" && this.args[i + 1] === "pipe:0") {
        if (firstPipeIndex === -1) {
          firstPipeIndex = i;
        } else {
          this.args.splice(i, 2);
        }
      }
    }
    this.inputStreams = this.inputStreams.slice(0, 1);

    buildEncoder(this);

    // Ensure raw PCM decode inserted if needed
    const sr = this.audioTransformConfig.sampleRate;
    const ch = this.audioTransformConfig.channels;

    let haveInputRaw = false;
    let haveCodec = false;
    for (let i = 0; i < this.args.length; ++i) {
      if (this.args[i] === "-f" && this.args[i + 1] === "s16le")
        haveInputRaw = true;
      if (
        (this.args[i] === "-acodec" || this.args[i] === "-c:a") &&
        this.args[i + 1] === "pcm_s16le"
      )
        haveCodec = true;
    }
    if (!haveInputRaw || !haveCodec) {
      const firstInputIdx = this.args.findIndex(
        (x, i) => x === "-i" && this.args[i + 1] === "pipe:0",
      );
      let insertPos = firstInputIdx + 2;
      this.args.splice(
        insertPos,
        0,
        "-f",
        "s16le",
        "-ar",
        String(sr),
        "-ac",
        String(ch),
        "-acodec",
        "pcm_s16le",
      );
    }

    return this;
  }

  /**
   * Use an AudioPlugin (see Filters.js) to insert a JS transform in the PCM chain. buildEncoder lets you configure target encoding/output after processing.
   * @param {AudioPlugin} plugin
   * @param {function(FluentStream):void} buildEncoder
   * @param {AudioPluginOptions} [opts]
   * @returns {FluentStream}
   */
  withAudioPlugin(
    plugin: AudioPlugin,
    buildEncoder: (enc: FluentStream) => void,
    opts?: AudioPluginOptions,
  ): FluentStream {
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

  /**
   * Build and attach a chain of audio plugins via registry.
   * Creates a composed Transform and delegates to withAudioTransform.
   */
  withAudioPlugins(
    registry: PluginRegistry,
    ...pluginConfigs: Array<string | { name: string; options?: Partial<AudioPluginOptions> }>
  ): FluentStream {
    const chain: FluentChain = registry.chain(...pluginConfigs);
    const transform = chain.getTransform();
    // capture controllers for hot updates
    (this as any)._pluginControllers = chain.getControllers();

    // Use defaults from registry.chain() (48000/2). Allow encoder to be configured afterwards by caller.
    return this.withAudioTransform(
      transform,
      (enc) => enc,
      { sampleRate: 48000, channels: 2 },
    );
  }

  /**
   * Preferable helper: use globally registered plugins by name.
   * Equivalent to withAudioPlugins(FluentStream.globalRegistry, ...configs)
   */
  usePlugins(
    ...pluginConfigs: Array<
      string | { name: string; options?: Partial<AudioPluginOptions> }
    >
  ): FluentStream {
    return this.withAudioPlugins(FluentStream.globalRegistry, ...pluginConfigs);
  }

  /** Shortcut for a single plugin by name with optional options */
  usePlugin(name: string, options?: Partial<AudioPluginOptions>): FluentStream {
    return this.usePlugins({ name, options });
  }

  /** Get controller instances of the last configured plugin chain (if any) */
  getPluginControllers(): AudioPlugin[] {
    return ((this as any)._pluginControllers ?? []) as AudioPlugin[];
  }

  /**
   * Execute the FFmpeg command. All processor events are re-emitted.
   * @param {{ffplay?: boolean, [key: string]: any}} [opts]
   * @returns {FFmpegRunResult}
   */
  run(opts: { ffplay?: boolean; [key: string]: any } = {}): FFmpegRunResult {
    for (const fifoPath of this.pendingFifos) {
      this.ensureFifoSync(fifoPath);
    }

    if (this.audioPluginConfig && !this.audioTransformConfig) {
      const t = this.audioPluginConfig.plugin.createTransform(
        this.audioPluginConfig.options,
      );
      const { sampleRate, channels } = this.audioPluginConfig.options;
      return this.withAudioTransform(t, this.audioPluginConfig.buildEncoder, {
        sampleRate,
        channels,
      }).run(opts);
    }

    const processor = new Processor({
      ffmpegPath: this.options.ffmpegPath,
      failFast: this.options.failFast,
      extraGlobalArgs: this.options.extraGlobalArgs,
      enableProgressTracking: this.options.enableProgressTracking,
      logger: this.options.logger as any,
    });

    if (this.audioTransformConfig) {
      if (this.inputStreams.length > 0) {
        const { transform } = this.audioTransformConfig;
        const userInput = this.inputStreams[0].stream;
        userInput.pipe(transform);
        processor.setInputStreams([
          { stream: transform as unknown as Readable, index: 0 },
        ]);
      }
    } else {
      if (this.inputStreams.length > 0)
        processor.setInputStreams(this.inputStreams);
    }

    processor.on("spawn", (data) => this.emit("spawn", data));
    processor.on("start", (cmd) => this.emit("start", cmd));
    processor.on("progress", (p) => this.emit("progress", p));
    processor.on("end", () => this.emit("end"));
    processor.on("terminated", (s) => this.emit("terminated", s));
    processor.on("error", (e) => this.emit("error", e as any));

    processor.setArgs(this.args);

    const { output, done, stop } = processor.run();

    return {
      output,
      done,
      stop,
    };
  }

  // ================= Utilities =================

  /**
   * Get current FFmpeg arguments.
   * @returns {string[]}
   */
  getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Get a string representation of the full FFmpeg command.
   * @returns {string}
   */
  toString(): string {
    return `${this.options.ffmpegPath} ${this.args.join(" ")}`;
  }

  /**
   * Get all configured input streams.
   * @returns {Array<{stream: Readable, index: number}>}
   */
  getInputStreams(): Array<{ stream: Readable; index: number }> {
    return this.inputStreams;
  }

  /**
   * Ensure that a FIFO file exists, creating it synchronously if needed.
   * Throws if existing path is not a FIFO.
   * @param {string} filePath
   * @private
   */
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
