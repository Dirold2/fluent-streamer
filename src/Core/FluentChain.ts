import { Transform, PassThrough, Writable, Readable } from "stream";
import { AudioPlugin, AudioPluginOptions } from "./Filters.js";
import PluginRegistry from "./PluginRegistry.js";

/**
 * FluentChain
 *
 * Wrapper around multiple AudioPlugins that allows piping sequentially.
 */
export class FluentChain {
  private transforms: Transform[] = [];
  private controllers: AudioPlugin[] = [];

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
    this.transforms = [];
    this.controllers = [];
    for (const { name, options } of this.pluginConfigs) {
      if (!this.registry.has(name))
        throw new Error(`Plugin not found: ${name}`);
      const mergedOptions: Required<AudioPluginOptions> = {
        ...this.defaultOptions,
        ...options,
      };
      const plugin = this.registry.create(name, mergedOptions);
      const transform = plugin.createTransform(mergedOptions);
      this.controllers.push(plugin);
      this.transforms.push(transform);
    }
  }

  /**
   * Pipe a source stream into the chain and then to a destination.
   */
  pipe(source: Readable, destination: Writable): void {
    if (this.transforms.length === 0) {
      source.pipe(destination);
      return;
    }

    // Ведущий трансформ, в который пишем из source
    const head: Transform = this.transforms[0];
    let current: Transform = head;

    // Связываем цепочку: head -> ... -> last
    for (let i = 1; i < this.transforms.length; i++) {
      current = current.pipe(this.transforms[i]);
    }

    // Подключаем источник и вывод
    source.pipe(head);
    current.pipe(destination);
  }

  /**
   * Get a single Transform stream representing the whole chain.
   */
  getTransform(): Transform {
    if (this.transforms.length === 0) return new PassThrough();

    // Собираем конвейер head -> ... -> last
    const head: Transform = this.transforms[0];
    let last: Transform = head;
    for (let i = 1; i < this.transforms.length; i++) {
      last = last.pipe(this.transforms[i]);
    }

    // Прокси-вход и выход, чтобы вернуть единый Transform
    const inputProxy = new PassThrough();
    const outputProxy = new PassThrough();

    // Направляем входной поток в голову цепочки
    inputProxy.pipe(head);
    // И направляем выход последнего звена в выходной прокси
    last.pipe(outputProxy);

    // Комбинированный Transform: пишет в inputProxy, читает из outputProxy
    const combined = new Transform({
      transform(chunk, _enc, cb) {
        // Пишем данные в входной прокси; он пойдет в head
        if (!inputProxy.write(chunk)) {
          inputProxy.once('drain', () => cb());
        } else {
          cb();
        }
      },
      flush(cb) {
        inputProxy.end();
        cb();
      },
    });

    // Передаем данные из выходного прокси наружу
    outputProxy.on('data', (chunk) => combined.push(chunk));
    outputProxy.once('end', () => combined.push(null));
    outputProxy.once('close', () => combined.push(null));

    // Пробрасываем ошибки
    const forwardError = (err: Error) => combined.emit('error', err);
    head.on('error', forwardError);
    last.on('error', forwardError);
    inputProxy.on('error', forwardError);
    outputProxy.on('error', forwardError);

    return combined;
  }

  /**
   * Return controller instances (plugin objects) to allow hot parameter updates
   */
  getControllers(): AudioPlugin[] {
    return [...this.controllers];
  }
}
