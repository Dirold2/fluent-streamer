import { AudioPluginOptions, AudioPlugin } from "./Filters.js";
import { FluentChain } from "./FluentChain.js";

type PluginFactory = (options: Required<AudioPluginOptions>) => AudioPlugin;

/**
 * Registry for audio plugins.
 *
 * Allows registering plugins by name and creating instances with specific options.
 */
export class PluginRegistry {
  private registry = new Map<string, PluginFactory>();

  /**
   * Registers an audio plugin.
   * @param name - Unique plugin name
   * @param factory - Factory function that creates the plugin instance
   */
  register(name: string, factory: PluginFactory) {
    this.registry.set(name, factory);
  }

  /**
   * Checks if a plugin with the given name is registered.
   * @param name - Plugin name
   * @returns True if registered, false otherwise
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Returns the factory for a registered plugin, or undefined if not found.
   */
  get(name: string): PluginFactory | undefined {
    return this.registry.get(name);
  }

  /**
   * Creates an instance of a registered plugin.
   * @param name - Plugin name
   * @param options - Plugin options
   * @throws Error if plugin is not found
   * @returns The created AudioPlugin instance
   */
  create(name: string, options: Required<AudioPluginOptions>): AudioPlugin {
    const factory = this.registry.get(name);
    if (!factory) throw new Error(`Plugin not found: ${name}`);
    return factory(options);
  }

  /**
   * Create a fluent chain of plugins with optional individual options.
   * @param pluginConfigs - Array of plugin names or objects { name, options }
   */
  chain(
    ...pluginConfigs: Array<
      string | { name: string; options?: Partial<AudioPluginOptions> }
    >
  ): FluentChain {
    if (pluginConfigs.length === 0) throw new Error("No plugin names provided");

    // Normalize plugin configs
    const configs = pluginConfigs.map((p) =>
      typeof p === "string" ? { name: p, options: {} } : p,
    );

    const defaultOptions: Required<AudioPluginOptions> = {
      sampleRate: 48000,
      channels: 2,
    };
    return new FluentChain(this, configs, defaultOptions);
  }
}

export default PluginRegistry;
