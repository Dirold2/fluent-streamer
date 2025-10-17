"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginRegistry = void 0;
const FluentChain_1 = require("./FluentChain");
/**
 * Registry for audio plugins.
 *
 * Allows registering plugins by name and creating instances with specific options.
 */
class PluginRegistry {
    registry = new Map();
    /**
     * Registers an audio plugin.
     * @param name - Unique plugin name
     * @param factory - Factory function that creates the plugin instance
     */
    register(name, factory) {
        this.registry.set(name, factory);
    }
    /**
     * Checks if a plugin with the given name is registered.
     * @param name - Plugin name
     * @returns True if registered, false otherwise
     */
    has(name) {
        return this.registry.has(name);
    }
    /**
     * Creates an instance of a registered plugin.
     * @param name - Plugin name
     * @param options - Plugin options
     * @throws Error if plugin is not found
     * @returns The created AudioPlugin instance
     */
    create(name, options) {
        const factory = this.registry.get(name);
        if (!factory)
            throw new Error(`Audio plugin not found: ${name}`);
        return factory(options);
    }
    /**
     * Create a fluent chain of plugins with optional individual options.
     * @param pluginConfigs - Array of plugin names or objects { name, options }
     */
    chain(...pluginConfigs) {
        if (pluginConfigs.length === 0)
            throw new Error("No plugin names provided");
        // Normalize plugin configs
        const configs = pluginConfigs.map((p) => typeof p === "string" ? { name: p, options: {} } : p);
        const defaultOptions = { sampleRate: 48000, channels: 2 };
        return new FluentChain_1.FluentChain(this, configs, defaultOptions);
    }
}
exports.PluginRegistry = PluginRegistry;
exports.default = PluginRegistry;
//# sourceMappingURL=PluginRegistry.js.map