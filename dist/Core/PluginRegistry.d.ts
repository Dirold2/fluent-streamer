import { AudioPluginBaseOptions, AudioPlugin } from "./Filters.js";
import { FluentChain } from "./FluentChain.js";
/** Универсальная фабрика плагина с дженериком для опций */
export type PluginFactory<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions> = (options: Required<Options>) => AudioPlugin<Options>;
/**
 * Registry for audio plugins.
 */
export declare class PluginRegistry {
    private registry;
    /** Регистрирует плагин */
    register<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions>(name: string, factory: PluginFactory<Options>): void;
    /** Проверяет, зарегистрирован ли плагин */
    has(name: string): boolean;
    /** Получает фабрику плагина */
    get(name: string): PluginFactory | undefined;
    /** Создаёт экземпляр плагина с конкретными опциями */
    create<Options extends AudioPluginBaseOptions>(name: string, options: Required<Options>): AudioPlugin<Options>;
    /** Создаёт цепочку FluentChain */
    chain(...pluginConfigs: Array<string | {
        name: string;
        options?: Partial<AudioPluginBaseOptions>;
    }>): FluentChain;
}
export default PluginRegistry;
