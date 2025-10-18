import { Transform } from "stream";

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