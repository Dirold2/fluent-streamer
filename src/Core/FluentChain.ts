import { Transform, PassThrough, Writable, Readable, pipeline } from "stream";
import { AudioPlugin, AudioPluginBaseOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";

/**
 * FluentChain
 *
 * A wrapper for connecting several AudioPlugin (Transform streams) in sequence.
 *
 * @example <caption>Basic chaining and piping</caption>
 * import { Readable, Writable } from "stream";
 * import { FluentChain } from "./FluentChain";
 * import { PluginRegistry } from "./PluginRegistry";
 *
 * const myRegistry = new PluginRegistry();
 * // Assume plugins "gain" and "compressor" are registered in myRegistry
 * const pluginConfigs = [
 *   { name: "gain", options: { gain: 1.5 } },
 *   { name: "compressor", options: { threshold: -10 } }
 * ];
 * const defaultOptions = { sampleRate: 44100, channels: 2, bitDepth: 16 };
 *
 * const chain = new FluentChain(myRegistry, pluginConfigs, defaultOptions);
 * const source = Readable.from(* some audio data *);
 * const dest = new Writable({ write(chunk, enc, cb) { * ... * cb(); } });
 *
 * chain.pipe(source, dest);
 *
 * @example <caption>Get a Transform for integration with pipeline()</caption>
 * import { pipeline } from "stream";
 * 
 * const transform = chain.getTransform();
 * pipeline(source, transform, dest, (err) => {
 *   if (err) {
 *     console.error("Pipeline error:", err);
 *   }
 * });
 */
export class FluentChain {
  private transforms: Transform[] = [];
  private controllers: AudioPlugin[] = [];

  /**
   * Constructs a new FluentChain.
   * @param registry - The plugin registry containing available plugins.
   * @param pluginConfigs - The ordered list of plugins to use and their options.
   * @param defaultOptions - The default options to apply to each plugin.
   */
  constructor(
    private readonly registry: PluginRegistry,
    private readonly pluginConfigs: Array<{
      name: string;
      options?: Partial<AudioPluginBaseOptions>;
    }>,
    private readonly defaultOptions: Required<AudioPluginBaseOptions>,
  ) {
    this.buildChain();
  }

  /**
   * Initializes the chain of Transform streams based on plugin configuration.
   * Throws if a plugin is not found in the registry.
   */
  private buildChain(): void {
    this.transforms = [];
    this.controllers = [];
    for (const { name, options } of this.pluginConfigs) {
      if (!this.registry.has(name)) {
        throw new Error(`Plugin not found: ${name}`);
      }
      // Merge defaultOptions with plugin-specific options
      const mergedOptions: Required<AudioPluginBaseOptions> = {
        ...this.defaultOptions,
        ...options,
      };
      // Instantiate the plugin using the registry
      const plugin: AudioPlugin = this.registry.create(name, mergedOptions);

      // Use createTransform if present, otherwise fallback to getTransform
      let transform: Transform;
      if (typeof plugin.createTransform === "function") {
        transform = plugin.createTransform(mergedOptions);
      } else if (typeof plugin.getTransform === "function") {
        transform = plugin.getTransform();
      } else {
        throw new Error(`Plugin "${name}" does not provide a createTransform or getTransform method.`);
      }

      this.controllers.push(plugin);
      this.transforms.push(transform);
    }
  }

  /**
   * Pipes the source Readable through all plugin transforms into the destination Writable.
   * Handles errors from any stream in the chain.
   * 
   * @param source - The input Readable stream.
   * @param destination - The output Writable stream.
   * @example
   * chain.pipe(sourceStream, destStream);
   */
  pipe(source: Readable, destination: Writable): void {
    const streams = [source, ...this.transforms, destination];
    pipeline(streams, (err) => {
      if (err) {
        // Errors from anywhere in the chain will be propagated here.
        source.emit("error", err);
        destination.emit("error", err);
      }
    });
  }

  /**
   * Returns a single Transform stream representing the entire plugin chain.
   * Useful for embedding the whole chain as a single element in another pipeline.
   * 
   * @returns {Transform} A transform that pipes data through all plugins.
   * @example
   * pipeline(source, chain.getTransform(), destination, cb);
   */
  getTransform(): Transform {
    if (this.transforms.length === 0) {
      return new PassThrough();
    }
    if (this.transforms.length === 1) {
      return this.transforms[0];
    }

    // Use pipeline to reliably connect streams and propagate errors.
    // `pipeline` will properly destroy all streams on error.
    const head = this.transforms[0];
    const tail = this.transforms[this.transforms.length - 1];
    
    pipeline(this.transforms, (err) => {
      // If any stream errors, emit from the head so the outer pipeline can catch it.
      if (err) {
        head.emit("error", err);
      }
    });

    // Create a duplex stream: write to 'head', read from 'tail'
    const duplex = new PassThrough();
    duplex.pipe(head);
    tail.pipe(duplex);
    
    return duplex;
  }

  /**
   * Returns plugin controller instances for parameter control.
   * 
   * @returns {AudioPlugin[]} The plugin controller objects.
   * @example
   * const controllers = chain.getControllers();
   * controllers[0].setGain(2.0);
   */
  getControllers(): AudioPlugin[] {
    return [...this.controllers];
  }
}