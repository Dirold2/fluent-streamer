import { Transform } from "stream";
/** Базовые опции для всех плагинов — могут быть расширены конкретными плагинами */
export interface AudioPluginBaseOptions {
    sampleRate?: number;
    channels?: number;
    [key: string]: any;
}
/** Универсальный AudioPlugin с дженериком для конкретных опций */
export interface AudioPlugin<Options extends AudioPluginBaseOptions = AudioPluginBaseOptions> {
    /** Имя плагина для логов и регистрации */
    name?: string;
    /** Создаёт Transform с конкретными опциями плагина */
    createTransform(options: Required<Options>): Transform;
    /** Опциональный метод для динамического обновления настроек плагина */
    setOptions?(options: Partial<Options>): void;
    /** Опциональный метод для получения текущих настроек */
    getOptions?(): Required<Options>;
}
