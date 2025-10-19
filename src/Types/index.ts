import { PassThrough, Readable, Transform } from "stream";

// ====================== Logging ======================

/**
 * Logger interface for debugging, warnings, and errors.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, any>): void;
  info(message: string, meta?: Record<string, any>): void;
  log(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  error(message: string, meta?: Record<string, any>): void;
}

// ====================== ProcessorOptions ======================

/**
 * Base options for configuring ProcessorOptions and the Processor core.
 */
export interface ProcessorOptions {
  /** Path to ffmpeg (default: "ffmpeg") */
  ffmpegPath?: string;
  /** Abort on first critical error */
  failFast?: boolean;
  /** Extra global arguments for ffmpeg (e.g., -hide_banner) */
  extraGlobalArgs?: string[];
  /** Max process runtime in ms (0 = unlimited) */
  timeout?: number;
  /** Maximum stderr buffer size (default: 1MB) */
  maxStderrBuffer?: number;
  /** Enable progress tracking (emits "progress" event) */
  enableProgressTracking?: boolean;
  /** Custom logger */
  logger?: Logger;
  /** Debug logger */
  debug?: boolean;
  /** Logger tag for log messages */
  loggerTag?: string;
  /** AbortSignal for process cancellation */
  abortSignal?: AbortSignal;
  /** Suppress logging of "premature close" warning */
  suppressPrematureCloseWarning?: boolean;
  /**
   * HTTP headers for network requests by ffmpeg (as object or string).
   */
  headers?: Record<string, string> | string;
}

/**
 * Current progress state of the ffmpeg process.
 *
 * All fields are optional and may not always be present.
 */
export interface FFmpegProgress {
  /** Number of frames processed */
  frame?: number;
  /** Processing frames per second */
  fps?: number;
  /** Current bitrate (e.g. "1700kbits/s") */
  bitrate?: string;
  /** Output file size in bytes */
  totalSize?: number;
  /** Output time in microseconds */
  outTimeUs?: number;
  /** Output time as string ("00:01:30.05") */
  outTime?: string;
  /** Number of duplicated frames */
  dupFrames?: number;
  /** Number of dropped frames */
  dropFrames?: number;
  /** Processing speed (e.g. 1 = realtime) */
  speed?: number;
  /** Progress stage ("continue", "end") */
  progress?: string;
  /** Output size (parsed in Processor.parseProgress) */
  size?: string;
  /** Output time (parsed in Processor.parseProgress) */
  time?: string;
  /** Current packet number (parsed in Processor.parseProgress) */
  packet?: number;
  /** Current chapter number (parsed in Processor.parseProgress) */
  chapter?: number;
}

/**
 * Statistics about the ffmpeg process run.
 */
export interface FFmpegStats {
  startTime: Date;
  endTime?: Date;
  duration?: number;
  exitCode?: number;
  signal?: string;
  stderrLines: number;
  bytesProcessed: number;
}

/**
 * The result of the ffmpeg run.
 */
export interface FFmpegRunResult {
  /** Main output stream (stdout) */
  output: PassThrough;
  /** Promise resolving when the process ends */
  done: Promise<void>;
  /** Function to stop the process */
  stop: () => void;
}

/**
 * Options for an ffmpeg task supporting both string and stream inputs.
 */
export interface StreamableFFmpegOptions extends ProcessorOptions {
  input?: string | Readable;
}

/**
 * Representation of a single ffmpeg job in the queue.
 */
export interface FFmpegJob {
  name: string;
  options: StreamableFFmpegOptions;
  resolve: (result: FFmpegRunResult) => void;
  reject: (err: Error) => void;
}

/**
 * Configuration for the ffmpeg job manager.
 */
export interface FFmpegManagerOptions {
  /** Maximum number of allowed restarts */
  maxRestarts?: number;
  /** Maximum number of parallel ffmpeg jobs */
  concurrency?: number;
  logger?: Logger;
  /** Number of retry attempts on failure */
  retry?: number;
  /** Whether to auto-restart jobs on failure */
  autoRestart?: boolean;
}

/**
 * Basic options shared by all audio plugins.
 * Can be extended in specific plugin implementations.
 *
 * @example <caption>Extending base options</caption>
 * interface MyPluginOptions extends AudioPluginBaseOptions {
 *   gain: number;
 * }
 *
 * @example <caption>Using in a plugin registration</caption>
 * const options: AudioPluginBaseOptions = { sampleRate: 44100, channels: 2 };
 */
export interface AudioPluginBaseOptions {
  sampleRate?: number;
  channels?: number;
  [key: string]: any; // Allows plugins to accept additional custom options.
}

/**
 * Generic interface for an audio plugin.
 * Should be implemented by all custom audio plugin transforms.
 *
 * @template Options - Type of options specific to the plugin.
 *
 * @example <caption>Minimal custom plugin implementing AudioPlugin</caption>
 * import { Transform } from "stream";
 *
 * interface GainOptions extends AudioPluginBaseOptions {
 *   gain: number;
 * }
 *
 * class GainPlugin implements AudioPlugin<GainOptions> {
 *   readonly name = "gain";
 *   private options: Required<GainOptions>;
 *   constructor(opts: Required<GainOptions>) {
 *     this.options = opts;
 *   }
 *   createTransform(options: Required<GainOptions>): Transform {
 *     // Return a Transform that applies gain.
 *     return new Transform({
 *       transform(chunk, encoding, callback) {
 *         // ... audio gain logic here ...
 *         callback(null, chunk);
 *       }
 *     });
 *   }
 *   setOptions(options: Partial<GainOptions>): void {
 *     this.options = { ...this.options, ...options };
 *   }
 *   getOptions(): Required<GainOptions> {
 *     return this.options;
 *   }
 * }
 */
export interface AudioPlugin<
  Options extends AudioPluginBaseOptions = AudioPluginBaseOptions,
> {
  /**
   * Plugin name, used for registration and logging.
   */
  readonly name?: string;

  /**
   * Creates a Transform stream to process audio.
   * Optional: If not implemented, the plugin must provide a "getTransform" method instead.
   * @param options The complete set of options (with defaults applied).
   * @returns {Transform} Stream for processing audio.
   *
   * @example
   * const plugin = new GainPlugin({ gain: 2, sampleRate: 44100, channels: 2 });
   * const audioTransform = plugin.createTransform
   *   ? plugin.createTransform(plugin.getOptions())
   *   : plugin.getTransform(); // fallback for plugins that only provide getTransform
   */
  createTransform?(options: Required<Options>): Transform;

  /**
   * (Legacy/compatibility) Some plugins may only provide getTransform().
   * This method should be used as a fallback if createTransform is not present.
   * @returns {Transform} Stream for processing audio.
   */
  getTransform?(): Transform;

  /**
   * Optional. Dynamically update plugin options "on the fly".
   * @param options Partial set of options to update.
   *
   * @example
   * plugin.setOptions({ gain: 1.5 });
   */
  setOptions?(options: Partial<Options>): void;

  /**
   * Optional. Get the plugin's current (complete) options.
   * @returns {Required<Options>} The current full options object.
   *
   * @example
   * const opts = plugin.getOptions();
   * console.log(opts.sampleRate, opts.gain);
   */
  getOptions?(): Required<Options>;
}

/**
 * Type of a factory function for creating plugin instances.
 * @template Options - The type of options accepted by the plugin.
 *
 * @example
 * ```ts
 * interface GainOptions extends AudioPluginBaseOptions {
 *   gain: number;
 * }
 *
 * class GainPlugin implements AudioPlugin<GainOptions> { ... }
 *
 * const registry = new PluginRegistry();
 * registry.register("gain", (opts) => new GainPlugin(opts));
 * ```
 */
export type PluginFactory<
  Options extends AudioPluginBaseOptions = AudioPluginBaseOptions,
> = (options: Required<Options>) => AudioPlugin<Options>;
