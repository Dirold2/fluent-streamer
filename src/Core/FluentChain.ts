import { Transform, PassThrough, Writable } from "stream";
import { AudioPluginOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";

/**
 * FluentChain
 *
 * Wrapper around multiple AudioPlugins that allows piping sequentially.
 */
export class FluentChain {
  private transforms: Transform[] = [];

  constructor(
    private registry: PluginRegistry,
    private pluginConfigs: Array<{
      name: string;
      options?: Partial<AudioPluginOptions>;
    }>,
    private defaultOptions: Required<AudioPluginOptions>,
  ) {
    this.buildChain();
  }

  /**
   * Build Transform streams from plugin names and options.
   */
  private buildChain(): void {
    this.transforms = this.pluginConfigs.map(({ name, options }) => {
      if (!this.registry.has(name))
        throw new Error(`Plugin not found: ${name}`);
      const mergedOptions: Required<AudioPluginOptions> = {
        ...this.defaultOptions,
        ...options,
      };
      return this.registry
        .create(name, mergedOptions)
        .createTransform(mergedOptions);
    });
  }

  /**
   * Pipe a source stream into the chain and then to a destination.
   */
  pipeTo(destination: Writable): void {
    if (this.transforms.length === 0) {
      new PassThrough().pipe(destination);
      return;
    }

    // Начало цепочки
    let first: Transform = this.transforms[0];

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
  getTransform(): Transform {
    if (this.transforms.length === 0) return new PassThrough();
    let current: Transform = this.transforms[0];
    for (let i = 1; i < this.transforms.length; i++) {
      const next = this.transforms[i];
      current = current.pipe(next);
    }
    return current;
  }
}
