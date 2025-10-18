"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginRegistry = void 0;
const FluentChain_js_1 = require("./FluentChain.js");
/**
 * Registry for audio plugins.
 */
class PluginRegistry {
    registry = new Map();
    /** Регистрирует плагин */
    register(name, factory) {
        this.registry.set(name, factory);
    }
    /** Проверяет, зарегистрирован ли плагин */
    has(name) {
        return this.registry.has(name);
    }
    /** Получает фабрику плагина */
    get(name) {
        return this.registry.get(name);
    }
    /** Создаёт экземпляр плагина с конкретными опциями */
    create(name, options) {
        const factory = this.registry.get(name);
        if (!factory)
            throw new Error(`Plugin not found: ${name}`);
        // Приведение типов для корректной работы дженериков
        return factory(options);
    }
    /** Создаёт цепочку FluentChain */
    chain(...pluginConfigs) {
        if (pluginConfigs.length === 0)
            throw new Error("No plugin names provided");
        const configs = pluginConfigs.map((p) => typeof p === "string" ? { name: p, options: {} } : p);
        const defaultOptions = {
            sampleRate: 48000,
            channels: 2,
        };
        return new FluentChain_js_1.FluentChain(this, configs, defaultOptions);
    }
}
exports.PluginRegistry = PluginRegistry;
exports.default = PluginRegistry;
//# sourceMappingURL=PluginRegistry.js.map