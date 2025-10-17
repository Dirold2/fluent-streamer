"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FluentChain = void 0;
const stream_1 = require("stream");
/**
 * FluentChain
 *
 * Wrapper around multiple AudioPlugins that allows piping sequentially.
 */
class FluentChain {
    registry;
    pluginConfigs;
    defaultOptions;
    transforms = [];
    constructor(registry, pluginConfigs, defaultOptions) {
        this.registry = registry;
        this.pluginConfigs = pluginConfigs;
        this.defaultOptions = defaultOptions;
        this.buildChain();
    }
    /**
     * Build Transform streams from plugin names and options.
     */
    buildChain() {
        this.transforms = this.pluginConfigs.map(({ name, options }) => {
            if (!this.registry.has(name))
                throw new Error(`Plugin not found: ${name}`);
            const mergedOptions = { ...this.defaultOptions, ...options };
            return this.registry.create(name, mergedOptions).createTransform(mergedOptions);
        });
    }
    /**
     * Pipe a source stream into the chain and then to a destination.
     */
    pipeTo(destination) {
        if (this.transforms.length === 0) {
            new stream_1.PassThrough().pipe(destination);
            return;
        }
        // Начало цепочки
        let first = this.transforms[0];
        // Присоединяем все промежуточные трансформы
        for (let i = 1; i < this.transforms.length; i++) {
            first.pipe(this.transforms[i]);
        }
        // Подключаем к destination
        first.pipe(destination);
    }
    /**
     * Get a single Transform stream representing the whole chain.
     */
    getTransform() {
        if (this.transforms.length === 0)
            return new stream_1.PassThrough();
        let current = this.transforms[0];
        for (let i = 1; i < this.transforms.length; i++) {
            const next = this.transforms[i];
            current = current.pipe(next);
        }
        return current;
    }
}
exports.FluentChain = FluentChain;
//# sourceMappingURL=FluentChain.js.map