import {
  AudioPluginBaseOptions,
  AudioPlugin,
  PluginFactory,
} from "../Types/index.js";
import { FluentChain } from "./FluentChain.js";

/**
 * Central registry and factory manager for audio plugins.
 *
 * This class maintains a registry of audio plugin factories that can be registered under a unique name.
 * It provides methods to register plugins, create plugin instances by name, build signal processing chains,
 * list registered plugins, and remove or clear plugins from the registry.
 *
 * ## Example: Register, Create, and Chain Plugins
 * ```ts
 * import { PluginRegistry } from "./PluginRegistry";
 *
 * const registry = new PluginRegistry();
 *
 * // Register plugins
 * registry.register("gain", (opts) => new GainPlugin(opts));
 * registry.register("compressor", (opts) => new CompressorPlugin(opts), true);
 *
 * // Create instance by name
 * const gain = registry.create("gain", { sampleRate: 44100, channels: 2, gain: 1.25 });
 *
 * // Create a processing chain
 * const chain = registry.chain(
 *   { name: "gain", options: { gain: 1.5 } },
 *   { name: "compressor", options: { threshold: -10 } }
 * );
 *
 * // List all registered plugin names
 * console.log(registry.list());
 *
 * // Remove a plugin
 * registry.unregister("gain");
 *
 * // Clear all plugins
 * registry.clear();
 * ```
 */
export class PluginRegistry {
  /** Internal map storing plugin factories keyed by plugin name. */
  private readonly registry = new Map<string, PluginFactory>();

  /**
   * Register a plugin factory under a unique name. If a plugin with this name already exists,
   * it will be overwritten.
   *
   * @param name Unique plugin name.
   * @param factory A factory function to produce plugin instances.
   * @param log If true and the name already exists, a warning is printed to the console.
   *
   * @example
   * registry.register("gain", (opts) => new GainPlugin(opts));
   */
  register<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions>(
    name: string,
    factory: PluginFactory<Options>,
    log: boolean = false,
  ): void {
    if (this.registry.has(name) && log) {
      console.warn(
        `Plugin with name "${name}" is already registered. Overwriting.`,
      );
    }
    this.registry.set(name, factory as PluginFactory);
  }

  /**
   * Check if a plugin factory is registered under the given name.
   *
   * @param name Plugin name to check.
   * @returns `true` if the plugin exists, otherwise `false`.
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Retrieve the plugin factory function for a given name.
   *
   * @param name Registered plugin name.
   * @returns The corresponding PluginFactory or `undefined` if not found.
   */
  get(name: string): PluginFactory | undefined {
    return this.registry.get(name);
  }

  /**
   * Create a plugin instance by name and options. Throws an error if the plugin is not found.
   *
   * @param name Registered plugin name.
   * @param options Options to pass to the plugin factory (must include required properties).
   * @throws Error if the plugin is not found in the registry.
   * @returns The created plugin instance.
   */
  create<Options extends AudioPluginBaseOptions>(
    name: string,
    options: Required<Options>,
  ): AudioPlugin<Options> {
    const factory = this.registry.get(name);
    if (!factory) {
      const known = Array.from(this.registry.keys()).join(", ");
      throw new Error(
        `Plugin not found: ${name}. Registered plugins: ${known || "(none)"}`,
      );
    }
    // Stronger factory type assertion for safety
    return (factory as (opts: Required<Options>) => AudioPlugin<Options>)(
      options,
    );
  }

  /**
   * Create a processing chain (`FluentChain`) from the specified plugin names or configuration objects.
   * Plugins are chained in the order provided.
   *
   * @param pluginConfigs Each item is either a name (`string`) or an object `{ name, options }`.
   *   - If `string`, uses default empty options.
   *   - If config, merges options with defaults.
   * @throws Error if no plugins are provided.
   * @returns A `FluentChain` ready for processing.
   *
   * @example
   * registry.chain("gain", { name: "compressor", options: { threshold: -10 } })
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

    // Choose default options; could be improved to infer from configs if desired
    const defaultOptions: Required<AudioPluginBaseOptions> = {
      sampleRate: 48000,
      channels: 2,
    };

    return new FluentChain(this, configs, defaultOptions);
  }

  /**
   * List the names of all registered plugins.
   *
   * @returns An array of registered plugin names.
   */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Remove a registered plugin by name.
   *
   * @param name Plugin name.
   * @returns `true` if the plugin was removed, `false` if it was not found.
   */
  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  /**
   * Remove all plugin registrations from the registry.
   */
  clear(): void {
    this.registry.clear();
  }
}

export default PluginRegistry;
