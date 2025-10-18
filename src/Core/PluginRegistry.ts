import { AudioPluginBaseOptions, AudioPlugin } from "./Filters.js";
import { FluentChain } from "./FluentChain.js";

/** Универсальная фабрика плагина с дженериком для опций */
export type PluginFactory<
  Options extends AudioPluginBaseOptions = AudioPluginBaseOptions,
> = (options: Required<Options>) => AudioPlugin<Options>;

/**
 * Registry for audio plugins.
 */
export class PluginRegistry {
  private registry = new Map<string, PluginFactory>();

  /** Регистрирует плагин */
  register<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions>(
    name: string,
    factory: PluginFactory<Options>,
  ) {
    this.registry.set(name, factory as PluginFactory);
  }

  /** Проверяет, зарегистрирован ли плагин */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** Получает фабрику плагина */
  get(name: string): PluginFactory | undefined {
    return this.registry.get(name);
  }

  /** Создаёт экземпляр плагина с конкретными опциями */
  create<Options extends AudioPluginBaseOptions>(
    name: string,
    options: Required<Options>,
  ): AudioPlugin<Options> {
    const factory = this.registry.get(name);
    if (!factory) throw new Error(`Plugin not found: ${name}`);

    // Приведение типов для корректной работы дженериков
    return (
      factory as unknown as (opts: Required<Options>) => AudioPlugin<Options>
    )(options);
  }

  /** Создаёт цепочку FluentChain */
  chain(
    ...pluginConfigs: Array<
      string | { name: string; options?: Partial<AudioPluginBaseOptions> }
    >
  ): FluentChain {
    if (pluginConfigs.length === 0) throw new Error("No plugin names provided");

    const configs = pluginConfigs.map((p) =>
      typeof p === "string" ? { name: p, options: {} } : p,
    );

    const defaultOptions: Required<AudioPluginBaseOptions> = {
      sampleRate: 48000,
      channels: 2,
    };

    return new FluentChain(this, configs, defaultOptions);
  }
}

export default PluginRegistry;
