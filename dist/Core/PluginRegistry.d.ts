import { AudioPluginOptions, AudioPlugin } from "./Filters.js";
import { FluentChain } from "./FluentChain.js";
type PluginFactory = (options: Required<AudioPluginOptions>) => AudioPlugin;
/**
 * Registry for audio plugins.
 *
 * Allows registering plugins by name and creating instances with specific options.
 */
export declare class PluginRegistry {
    private registry;
    /**
     * Registers an audio plugin.
     * @param name - Unique plugin name
     * @param factory - Factory function that creates the plugin instance
     */
    register(name: string, factory: PluginFactory): void;
    /**
     * Checks if a plugin with the given name is registered.
     * @param name - Plugin name
     * @returns True if registered, false otherwise
     */
    has(name: string): boolean;
    /**
     * Returns the factory for a registered plugin, or undefined if not found.
     */
    get(name: string): PluginFactory | undefined;
    /**
     * Creates an instance of a registered plugin.
     * @param name - Plugin name
     * @param options - Plugin options
     * @throws Error if plugin is not found
     * @returns The created AudioPlugin instance
     */
    create(name: string, options: Required<AudioPluginOptions>): AudioPlugin;
    /**
     * Create a fluent chain of plugins with optional individual options.
     * @param pluginConfigs - Array of plugin names or objects { name, options }
     */
    chain(...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginOptions>;
    }>): FluentChain;
}
export default PluginRegistry;
