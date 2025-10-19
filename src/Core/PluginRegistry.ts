import {
  AudioPluginBaseOptions,
  AudioPlugin,
  PluginFactory,
} from "../Types/index.js";
import { FluentChain } from "./FluentChain.js";

/**
 * Registry for registering and managing audio plugins.
 * Allows central storage of plugin factories and creation of plugin instances.
 *
 * @example <caption>Registering and using plugins</caption>
 * ```ts
 * import { PluginRegistry } from "./PluginRegistry";
 *
 * // Assume GainPlugin and CompressorPlugin are implemented AudioPlugin classes.
 * registry.register("gain", (opts) => new GainPlugin(opts));
 * registry.register("compressor", (opts) => new CompressorPlugin(opts));
 *
 * // Create a plugin instance directly
 * const gain = registry.create("gain", { sampleRate: 44100, channels: 2, gain: 1.25 });
 *
 * // Compose a chain of plugins
 * const chain = registry.chain(
 *   { name: "gain", options: { gain: 1.5 } },
 *   { name: "compressor", options: { threshold: -10 } }
 * );
 * ```
 */
export class PluginRegistry {
  private readonly registry = new Map<string, PluginFactory>();

  /**
   * Register a new plugin in the registry.
   * @param name - Unique plugin name.
   * @param factory - Factory function for creating the plugin instance.
   *
   * @example
   * ```ts
   * registry.register("gain", (opts) => new GainPlugin(opts));
   * ```
   */
  register<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions>(
    name: string,
    factory: PluginFactory<Options>,
  ): void {
    if (this.registry.has(name)) {
      console.warn(
        `Plugin with name "${name}" is already registered. Overwriting.`,
      );
    }
    this.registry.set(name, factory as PluginFactory);
  }

  /**
   * Check if a plugin is registered under the given name.
   * @param name - Plugin name.
   * @returns {boolean} - true if plugin is registered.
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Get the plugin factory function by name.
   * @param name - Plugin name.
   * @returns {PluginFactory | undefined} - Factory function or undefined if plugin not found.
   */
  get(name: string): PluginFactory | undefined {
    return this.registry.get(name);
  }

  /**
   * Create an instance of a plugin with the given options.
   * @param name - Plugin name.
   * @param options - Options for creating the plugin.
   * @returns {AudioPlugin<Options>} - Plugin instance.
   *
   * @example
   * ```ts
   * const plugin = registry.create("gain", { sampleRate: 44100, channels: 2, gain: 1.0 });
   * ```
   */
  create<Options extends AudioPluginBaseOptions>(
    name: string,
    options: Required<Options>,
  ): AudioPlugin<Options> {
    const factory = this.registry.get(name);
    if (!factory) {
      throw new Error(`Plugin not found: ${name}`);
    }
    // This cast is necessary because the exact type `Options` is lost when the factory is stored in the Map.
    return (
      factory as unknown as (opts: Required<Options>) => AudioPlugin<Options>
    )(options);
  }

  /**
   * Create a chain of plugins for sequential processing.
   * @param pluginConfigs - Plugin configurations (either plugin name or object with name and options).
   * @returns {FluentChain} - A FluentChain instance connecting the plugins.
   *
   * @example
   * ```ts
   * const chain = registry.chain(
   *   "gain",
   *   { name: "compressor", options: { threshold: -10 } }
   * );
   * ```
   */
  chain(
    ...pluginConfigs: Array<
      string | { name: string; options?: Partial<AudioPluginBaseOptions> }
    >
  ): FluentChain {
    if (pluginConfigs.length === 0) {
      throw new Error("Cannot create a chain with no plugins.");
    }

    const configs = pluginConfigs.map((p) =>
      typeof p === "string" ? { name: p, options: {} } : p,
    );

    // Default options for all plugins in the chain
    const defaultOptions: Required<AudioPluginBaseOptions> = {
      sampleRate: 48000,
      channels: 2,
    };

    return new FluentChain(this, configs, defaultOptions);
  }
}

export default PluginRegistry;
