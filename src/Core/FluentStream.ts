/**
 * FluentStream - Fluent API for FFmpeg stream processing
 * FluentStream - Fluent API для обработки потоков FFmpeg
 *
 * Builder pattern for constructing FFmpeg commands with:
 * - Input/output management (streams and files)
 * - Audio effects control (volume, EQ, compression, fade)
 * - Complex filter chains
 * - Real-time effect adjustment
 *
 * Паттерн Builder для конструирования команд FFmpeg с:
 * - Управлением входами/выходами (потоки и файлы)
 * - Контролем аудиоэффектов (громкость, EQ, компрессия, затухание)
 * - Цепочками сложных фильтров
 * - Регулировкой эффектов в реальном времени
 *
 * WARNING: После .run() объект становится "грязным" (dirty).
 * Повторное использование ЗАПРЕЩЕНО до .clear()!
 *
 * ВНИМАНИЕ: После .run() объект становится "грязным" (dirty).
 * Повторное использование ЗАПРЕЩЕНО до .clear()!
 */

import { EventEmitter } from "eventemitter3";
import { Readable } from "node:stream";
import Processor from "./Processor.js";
import type {
  FFmpegRunResultExtended,
  ProcessorOptions,
  Logger,
  AudioProcessingOptions,
  LogMeta,
  CrossfadeAudioOptions,
  InputSource,
} from "../Types/index.js";

// ============================================================================
// CONSTANTS & DEFAULTS
// ============================================================================

/**
 * Humanization headers to identify requests
 * Заголовки гуманизации для идентификации запросов
 */
const HUMANITY_HEADERS = Object.freeze({
  "X-Human-Intent": "true",
  "X-Request-Attention": "just-want-to-do-my-best",
  "User-Agent": "FluentStream/1.0 (friendly bot)",
});

/**
 * Default no-op logger implementation
 * Реализация логгера по умолчанию (без операций)
 */
const DEFAULT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get stack trace for debugging
 * Получить стек вызовов для отладки
 *
 * @param skip - Number of frames to skip (количество фреймов для пропуска)
 */
function getStackTrace(skip = 2): string {
  const stack = new Error().stack;
  return stack
    ? stack
        .split("\n")
        .slice(skip)
        .filter((l) => !l.includes("node:internal"))
        .join("\n")
    : "";
}

/**
 * Count total inputs (string URLs + streams)
 * Подсчитать общее количество входов (URL + потоки)
 */
function countInputs(
  args: string[],
  inputStreams: Array<{ stream: Readable; index: number }>,
  inputSources: InputSource[],
): {
  streams: number;
  stringInputs: number;
  urlInputs: number;
  total: number;
} {
  let stringInputs = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") stringInputs++;
  }
  const urlInputs = inputSources.filter((s) => s.type === "url").length;
  return {
    streams: inputStreams.length,
    stringInputs,
    urlInputs,
    total: stringInputs + inputStreams.length + urlInputs,
  };
}

/**
 * Summarize inputs for debugging
 * Суммаризовать входы для отладки
 */
function summarizeInputs(
  args: string[],
  _inputStreams: Array<{ stream: Readable; index: number }>,
  complexFilters: string[],
  inputSources: InputSource[],
): {
  stringInputs: string[];
  urlInputs: string[];
  pipeStreams: string[];
  complexFilters: string[];
} {
  const result: {
    stringInputs: string[];
    urlInputs: string[];
    pipeStreams: string[];
    complexFilters: string[];
  } = {
    stringInputs: [],
    urlInputs: [],
    pipeStreams: [],
    complexFilters: [...complexFilters],
  };

  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") {
      const next = args[i + 1]!;
      if (/^pipe:\d+$/.test(next)) {
        result.pipeStreams.push(next);
      } else {
        result.stringInputs.push(next);
      }
    }
  }

  for (const source of inputSources) {
    if (source.type === "url") {
      result.urlInputs.push(source.url);
    }
  }

  return result;
}

// ============================================================================
// CUSTOM ERROR CLASS
// ============================================================================

/**
 * FluentStream validation error
 * Ошибка валидации FluentStream
 */
class FluentStreamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluentStreamValidationError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FluentStreamValidationError);
    }
  }
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * FluentStream - Builder API for FFmpeg command construction
 * FluentStream - Builder API для конструирования команд FFmpeg
 *
 * Chainable methods for building complex FFmpeg pipelines with audio effects.
 * Цепочечные методы для построения сложных FFmpeg пайплайнов с аудиоэффектами.
 */
export default class FluentStream extends EventEmitter {
  // ============================================================================
  // STATIC PROPERTIES
  // ============================================================================

  /** Static humanization headers / Статические заголовки гуманизации */
  static readonly HUMANITY_HEADERS = HUMANITY_HEADERS;

  // ============================================================================
  // PRIVATE PROPERTIES - CORE STATE
  // ============================================================================

  /** FFmpeg command arguments / Аргументы команды FFmpeg */
  private args: string[] = [];

  /** Input streams with indices / Входные потоки с индексами */
  private inputStreams: Array<{ stream: Readable; index: number }> = [];

  /** Input sources (URLs, blobs, etc.) / Источники входов (URL, blob и т.д.) */
  private inputSources: InputSource[] = [];

  /** Complex filter chains / Цепочки сложных фильтров */
  private complexFilters: string[] = [];

  /** Processor configuration / Конфигурация процессора */
  public readonly options: ProcessorOptions;

  /** Custom HTTP headers / Пользовательские HTTP-заголовки */
  private headers: Record<string, string> | undefined;

  /** Dirty flag (prevents reuse before .clear()) / Флаг "грязности" (предотвращает переиспользование) */
  private isDirty = false;

  // ============================================================================
  // PRIVATE PROPERTIES - AUDIO EFFECTS STATE
  // ============================================================================

  /** Current volume level (0-1) / Текущий уровень громкости (0-1) */
  private audioVolume = 1;

  /** Current bass level (-20 to 20) / Текущий уровень баса (-20 до 20) */
  private audioBass = 0;

  /** Current treble level (-20 to 20) / Текущий уровень верхних частот (-20 до 20) */
  private audioTreble = 0;

  /** Current compressor state / Текущее состояние компрессора */
  private audioCompressor = false;

  /** Whether to use AudioProcessor chain / Использовать ли цепь AudioProcessor */
  private enabledAudioProcessor = false;

  /** Cached audio processor options / Кэшированные опции аудио-процессора */
  private cachedAudioOptions: AudioProcessingOptions | null = null;

  /** Hash for cache invalidation / Хэш для инвалидации кэша */
  private cachedOptionsHash = "";

  // ============================================================================
  // PRIVATE PROPERTIES - INTERNAL
  // ============================================================================

  /** Logger instance / Экземпляр логгера */
  private logger: Logger;

  /** Active processor result (after .run()) / Активный результат процессора (после .run()) */
  private processorResult: FFmpegRunResultExtended | null = null;

  // ============================================================================
  // PUBLIC GETTERS & SETTERS
  // ============================================================================

  /**
   * Get/set volume (0-1) / Получить/установить громкость (0-1)
   */
  public get volume(): number {
    return this.audioVolume;
  }

  public set volume(value: number) {
    this.audioVolume = value;
    if (this.processorResult?.setVolume) {
      this.processorResult.setVolume(value);
    }
  }

  /**
   * Get/set bass (-20 to 20) / Получить/установить бас (-20 до 20)
   */
  public get bass(): number {
    return this.audioBass;
  }

  public set bass(value: number) {
    this.audioBass = value;
    if (this.processorResult?.setBass) {
      this.processorResult.setBass(value);
    }
  }

  /**
   * Get/set treble (-20 to 20) / Получить/установить верхние частоты (-20 до 20)
   */
  public get treble(): number {
    return this.audioTreble;
  }

  public set treble(value: number) {
    this.audioTreble = value;
    if (this.processorResult?.setTreble) {
      this.processorResult.setTreble(value);
    }
  }

  /**
   * Get/set compressor (true/false) / Получить/установить компрессор (true/false)
   */
  public get compressor(): boolean {
    return this.audioCompressor;
  }

  public set compressor(value: boolean) {
    this.audioCompressor = value;
    if (this.processorResult?.setCompressor) {
      this.processorResult.setCompressor(value);
    }
  }

  /**
   * Get/set audio processor enabled / Получить/установить включение аудио-процессора
   */
  public get useAudioProcessor(): boolean {
    return this.enabledAudioProcessor;
  }

  public set useAudioProcessor(value: boolean) {
    this.enabledAudioProcessor = value;
  }

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  /**
   * Create FluentStream instance
   * Создать экземпляр FluentStream
   *
   * @param options - Processor options (опции процессора)
   */
  constructor(options: ProcessorOptions = {}) {
    super();

    this.options = { ...options };
    this.headers =
      typeof options.headers === "object" && options.headers !== null ? options.headers : undefined;
    this.logger = options.logger ?? DEFAULT_LOGGER;

    // Initialize audio settings from options
    this.enabledAudioProcessor = options.useAudioProcessor ?? false;
    this.audioVolume = options.audioProcessorOptions?.volume ?? 1;
    this.audioBass = options.audioProcessorOptions?.bass ?? 0;
    this.audioTreble = options.audioProcessorOptions?.treble ?? 0;
    this.audioCompressor = options.audioProcessorOptions?.compressor ?? false;
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  /**
   * Emit log message with standardized format
   * Выпустить сообщение логирования со стандартным форматом
   */
  private emitLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: LogMeta,
  ): void {
    const fullMeta = { ...meta };
    if (!fullMeta.stackTrace) {
      fullMeta.stackTrace = getStackTrace();
    }

    if (typeof this.logger[level] === "function") {
      this.logger[level](message, fullMeta);
    }
  }

  /**
   * Build cached audio processor options
   * Создать кэшированные опции аудио-процессора
   */
  private buildAudioOptions(): AudioProcessingOptions {
    const hash = `${this.audioVolume}-${this.audioBass}-${this.audioTreble}-${this.audioCompressor}`;

    if (this.cachedAudioOptions && this.cachedOptionsHash === hash) {
      return this.cachedAudioOptions;
    }

    this.cachedAudioOptions = {
      volume: this.audioVolume,
      bass: this.audioBass,
      treble: this.audioTreble,
      compressor: this.audioCompressor,
      normalize: false,
      sampleRate: this.options.audioProcessorOptions?.sampleRate,
      channels: this.options.audioProcessorOptions?.channels,
    };
    this.cachedOptionsHash = hash;

    return this.cachedAudioOptions;
  }

  /**
   * Get merged headers (user + humanity headers)
   * Получить объединённые заголовки (пользовательские + гуманизирующие)
   */
  private getMergedHeaders(): Record<string, string> {
    if (!this.headers || Object.keys(this.headers).length === 0) {
      return { ...HUMANITY_HEADERS };
    }
    return { ...this.headers };
  }

  /**
   * Create Processor with current configuration
   * Создать Processor с текущей конфигурацией
   */
  private createProcessor(extraOpts: Partial<ProcessorOptions> = {}): Processor {
    const mergedHeaders = this.getMergedHeaders();

    const finalOptions: ProcessorOptions = {
      ...this.options,
      ...extraOpts,
      headers: mergedHeaders,
      useAudioProcessor: this.enabledAudioProcessor,
      audioProcessorOptions: this.buildAudioOptions(),
      inputStreams: this.inputStreams,
      inputSources: this.inputSources,
    };

    const processor = Processor.create({
      options: finalOptions,
      args: this.assembleArgs(),
      inputStreams: this.inputStreams,
    });
    processor.setInputSources(this.inputSources);
    return processor;
  }

  /**
   * Validate not dirty before modification
   * Проверить, что не "грязно" перед модификацией
   */
  private requireClean(operation: string): void {
    if (this.isDirty) {
      throw new FluentStreamValidationError(
        `Cannot use .${operation}() after .run() without .clear()`,
      );
    }
  }

  // ============================================================================
  // PUBLIC API - AUDIO EFFECTS (Chainable)
  // ============================================================================

  /**
   * Set volume (chainable) / Установить громкость (цепочечный)
   */
  public setVolume(value: number): this {
    this.volume = value;
    return this;
  }

  /**
   * Start fade-in effect / Начать эффект появления
   */
  public fadeIn(targetVolume: number = 1, durationMs: number = 1000): this {
    this.audioVolume = targetVolume;
    if (this.processorResult?.startFade) {
      this.processorResult.startFade(targetVolume, durationMs);
    }
    return this;
  }

  /**
   * Start fade-out effect / Начать эффект затухания
   */
  public fadeOut(durationMs: number = 1000): this {
    this.audioVolume = 0;
    if (this.processorResult?.startFade) {
      this.processorResult.startFade(0, durationMs);
    }
    return this;
  }

  /**
   * Set bass level (chainable) / Установить уровень баса (цепочечный)
   */
  public setBass(value: number): this {
    this.bass = value;
    return this;
  }

  /**
   * Set treble level (chainable) / Установить уровень верхних частот (цепочечный)
   */
  public setTreble(value: number): this {
    this.treble = value;
    return this;
  }

  /**
   * Set compressor state (chainable) / Установить состояние компрессора (цепочечный)
   */
  public setCompressor(enabled: boolean): this {
    this.compressor = enabled;
    return this;
  }

  /**
   * Set all EQ parameters at once / Установить все параметры EQ сразу
   */
  public setEqualizer(bass: number, treble: number, compressor: boolean): this {
    this.bass = bass;
    this.treble = treble;
    this.compressor = compressor;
    return this;
  }

  /**
   * Enable audio processor chain / Включить цепь аудио-процессора
   */
  public enableAudioProcessing(enable: boolean = true): this {
    this.enabledAudioProcessor = enable;
    return this;
  }

  // ============================================================================
  // PUBLIC API - AUDIO EFFECTS (On-the-fly, after .run())
  // ============================================================================

  /**
   * Change volume during playback / Изменить громкость во время воспроизведения
   *
   * @returns true if applied, false if no active processor (успешно ли применено)
   */
  public changeVolume(value: number): boolean {
    if (this.processorResult?.setVolume) {
      this.processorResult.setVolume(value);
      this.audioVolume = value;
      return true;
    }
    return false;
  }

  /**
   * Change bass during playback / Изменить бас во время воспроизведения
   */
  public changeBass(value: number): boolean {
    if (this.processorResult?.setBass) {
      this.processorResult.setBass(value);
      this.audioBass = value;
      return true;
    }
    return false;
  }

  /**
   * Change treble during playback / Изменить верхние частоты во время воспроизведения
   */
  public changeTreble(value: number): boolean {
    if (this.processorResult?.setTreble) {
      this.processorResult.setTreble(value);
      this.audioTreble = value;
      return true;
    }
    return false;
  }

  /**
   * Change compressor during playback / Изменить компрессор во время воспроизведения
   */
  public changeCompressor(enabled: boolean): boolean {
    if (this.processorResult?.setCompressor) {
      this.processorResult.setCompressor(enabled);
      this.audioCompressor = enabled;
      return true;
    }
    return false;
  }

  /**
   * Change all EQ during playback / Изменить все EQ во время воспроизведения
   */
  public changeEqualizer(bass: number, treble: number, compressor: boolean): boolean {
    if (this.processorResult?.setEqualizer) {
      this.processorResult.setEqualizer(bass, treble, compressor);
      this.audioBass = bass;
      this.audioTreble = treble;
      this.audioCompressor = compressor;
      return true;
    }
    return false;
  }

  // ============================================================================
  // PUBLIC API - INPUT/OUTPUT
  // ============================================================================

  /**
   * Add input (file path/URL/blob or stream) / Добавить вход (путь/URL/blob или поток)
   *
   * @param input - File path, URL, blob URL, or Readable stream (путь файла, URL, blob URL или поток Readable)
   * @param opts - Options (опции)
   */
  public input(
    input: string | Readable | undefined | null,
    opts?: {
      label?: string;
      pipeIndex?: number;
      allowDuplicate?: boolean;
    },
  ): this {
    this.requireClean("input");

    if (input == null) {
      throw new FluentStreamValidationError(
        "input(): input must be non-null string (path/URL/blob) or Readable stream",
      );
    }

    if (typeof input === "string") {
      // Check if it's a blob URL
      if (input.startsWith("blob:")) {
        return this.inputBlob(input, opts?.pipeIndex);
      }

      // URL input: track via inputSources (Processor.getFullArgs() handles headers + -i)
      if (/^https?:\/\//i.test(input)) {
        if (
          !opts?.allowDuplicate &&
          this.inputSources.some((s) => s.type === "url" && s.url === input)
        ) {
          this.emitLog("warn", `input(): Duplicate URL input detected: "${input}"`, {
            code: "FluentStream-duplicate-url-input",
          });
          return this;
        }
        const index = this.inputSources.length;
        this.inputSources.push({ type: "url", url: input, index });
        return this;
      }

      // Local file input
      if (
        !opts?.allowDuplicate &&
        this.args.some((v, i) => v === "-i" && this.args[i + 1] === input)
      ) {
        this.emitLog("warn", `input(): Duplicate string input detected: "${input}"`, {
          code: "FluentStream-duplicate-string-input",
        });
        return this;
      }

      this.args.push("-i", input);
    } else if (typeof input.read === "function") {
      // Stream input
      let streamIdx: number;

      if (opts?.pipeIndex != null && Number.isFinite(opts.pipeIndex) && opts.pipeIndex >= 0) {
        if (this.inputStreams.some((entry) => entry.index === opts.pipeIndex)) {
          throw new FluentStreamValidationError(`input(): Duplicate pipe index: ${opts.pipeIndex}`);
        }
        streamIdx = opts.pipeIndex;
      } else {
        streamIdx = this.inputStreams.length;
      }

      if (!opts?.allowDuplicate && this.inputStreams.some((s) => s.stream === input)) {
        this.emitLog("warn", "input(): Duplicate Readable stream detected (skipped)", {
          code: "FluentStream-duplicate-pipe",
        });
        return this;
      }

      this.inputStreams.push({ stream: input, index: streamIdx });
      this.args.push("-i", `pipe:${streamIdx}`);
    } else {
      throw new FluentStreamValidationError(
        "input(): must be string (file/URL/blob) or Readable stream",
      );
    }

    return this;
  }

  /**
   * Set output (file path or pipe) / Установить выход (путь файла или pipe)
   */
  public output(output: string | Readable | number | { pipe?: string } | undefined | null): this {
    this.requireClean("output");

    if (output && typeof output === "object" && "pipe" in output && output.pipe) {
      const pipeName = output.pipe;

      if (pipeName === "stdout" || pipeName === "stderr" || pipeName === "1" || pipeName === "2") {
        const pipeTarget = pipeName === "stdout" || pipeName === "1" ? "pipe:1" : "pipe:2";
        this.args.push(pipeTarget);
        return this;
      }

      if (typeof pipeName === "string" && /^pipe:\d+$/.test(pipeName)) {
        this.args.push(pipeName);
        return this;
      }

      throw new FluentStreamValidationError(`output(): Invalid pipe target: ${String(pipeName)}`);
    }

    if (output == null || (typeof output === "string" && output.trim().length === 0)) {
      throw new FluentStreamValidationError("output(): requires non-empty string or pipe object");
    }

    this.args.push(String(output));
    return this;
  }

  /**
   * Get effective HTTP headers that will be passed to Processor/FFmpeg.
   * Получить итоговые HTTP-заголовки, которые будут переданы в Processor/FFmpeg.
   */
  public getHeaders(): Record<string, string> {
    return this.getMergedHeaders();
  }

  /**
   * Set HTTP headers / Установить HTTP-заголовки
   *
   * Headers are passed to Processor which applies them to HTTP(S) inputs.
   * They no longer appear in getArgs() — use Processor.getFullArgs() instead.
   */
  public setHeaders(headers?: Record<string, string> | null, opts?: { merge?: boolean }): this {
    this.requireClean("setHeaders");

    if (headers == null) {
      this.headers = undefined;
    } else if (!opts?.merge) {
      this.headers = headers;
    } else {
      this.headers = { ...this.headers, ...headers };
    }

    return this;
  }

  /**
   * Set user-agent header / Установить заголовок user-agent
   */
  public userAgent(userAgent?: string | null): this {
    this.requireClean("userAgent");

    // Remove existing -user_agent
    for (let i = 0; i < this.args.length; ) {
      if (this.args[i] === "-user_agent" && typeof this.args[i + 1] === "string") {
        this.args.splice(i, 2);
      } else {
        i++;
      }
    }

    if (userAgent && userAgent.length > 0) {
      const firstInput = this.args.findIndex((a) => a === "-i");
      if (firstInput !== -1) {
        this.args.splice(firstInput, 0, "-user_agent", userAgent);
      } else {
        this.args.unshift("-user_agent", userAgent);
      }

      const hasHTTPInput = this.args.some(
        (v, idx, arr) =>
          v === "-i" && typeof arr[idx + 1] === "string" && /^https?:\/\//.test(arr[idx + 1]!),
      );

      if (!hasHTTPInput) {
        this.emitLog(
          "warn",
          "userAgent: applies ONLY to HTTP/HTTPS inputs. FFmpeg will ignore it for other protocols.",
          { code: "FluentStream-non-http-useragent" },
        );
      }
    }

    return this;
  }

  // ============================================================================
  // PUBLIC API - OPTIONS
  // ============================================================================

  /**
   * Add input options (before first -i) / Добавить опции входа (перед первым -i)
   */
  public inputOptions(...opts: string[]): this {
    this.requireClean("inputOptions");

    const idx = this.args.lastIndexOf("-i");
    if (idx !== -1) {
      this.args.splice(idx, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }

    return this;
  }

  /**
   * Add output options (after all args) / Добавить опции выхода (после всех аргументов)
   */
  public outputOptions(...opts: string[]): this {
    this.args.push(...opts);
    return this;
  }

  /**
   * Add global options (before first -i) / Добавить глобальные опции (перед первым -i)
   */
  public globalOptions(...opts: string[]): this {
    const firstInput = this.args.findIndex((a) => a === "-i");
    if (firstInput !== -1) {
      this.args.splice(firstInput, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  /**
   * Set audio codec / Установить аудиокодек
   */
  public audioCodec(codec: string): this {
    if (codec) {
      this.args.push("-c:a", codec);
    }
    return this;
  }

  /**
   * Set video codec / Установить видеокодек
   */
  public videoCodec(codec: string): this {
    if (codec) {
      this.args.push("-c:v", codec);
    }
    return this;
  }

  /**
   * Set audio sample rate / Установить частоту дискретизации аудио
   */
  public audioFrequency(frequency: number): this {
    this.args.push("-ar", String(frequency));
    return this;
  }

  /**
   * Set number of audio channels / Установить количество аудиоканалов
   */
  public audioChannels(channels: number): this {
    this.args.push("-ac", String(channels));
    return this;
  }

  /**
   * Set output format / Установить выходной формат
   */
  public format(fmt: string): this {
    // Remove existing -f
    for (let i = 0; i < this.args.length - 1; ) {
      if (this.args[i] === "-f") {
        this.args.splice(i, 2);
      } else {
        i++;
      }
    }
    this.args.push("-f", fmt);
    return this;
  }

  /**
   * Disable video stream / Отключить видеопоток
   */
  public noVideo(): this {
    this.args.push("-vn");
    return this;
  }

  /**
   * Disable audio stream / Отключить аудиопоток
   */
  public noAudio(): this {
    this.args.push("-an");
    return this;
  }

  /**
   * Add complex filter / Добавить сложный фильтр
   */
  public complexFilter(graph: string | string[]): this {
    this.requireClean("complexFilter");

    if (Array.isArray(graph)) {
      for (const g of graph) {
        if (typeof g === "string" && g.trim()) {
          this.complexFilters.push(g);
        }
      }
    } else if (typeof graph === "string" && graph.trim()) {
      this.complexFilters.push(graph);
    }

    return this;
  }

  /**
   * Add stream map / Добавить маппирование потока
   */
  public map(spec: string): this {
    this.args.push("-map", spec);
    return this;
  }

  /**
   * Set seek position for input / Установить позицию seek для входа
   */
  public seekInput(position: number | string): this {
    this.requireClean("seekInput");

    if (position == null || (typeof position === "string" && !position.trim())) {
      throw new FluentStreamValidationError(
        "seekInput: position must be non-empty string or number",
      );
    }

    const firstInput = this.args.findIndex((a) => a === "-i");
    if (firstInput === -1) {
      this.args.unshift("-ss", String(position));
    } else {
      this.args.splice(firstInput, 0, "-ss", String(position));
    }

    return this;
  }

  /**
   * Set duration limit / Установить лимит длительности
   */
  public duration(time: number | string): this {
    this.args.push("-t", String(time));
    return this;
  }

  /**
   * Force audio bitrate / Установить битрейт аудио
   */
  public audioBitrate(bitrate: string): this {
    this.args.push("-b:a", bitrate);
    return this;
  }

  /**
   * Force video bitrate / Установить битрейт видео
   */
  public videoBitrate(bitrate: string): this {
    this.args.push("-b:v", bitrate);
    return this;
  }

  /**
   * Enable file overwrite (-y flag) / Включить перезапись файла
   */
  public overwrite(): this {
    // Remove existing -y
    this.args = this.args.filter((a) => a !== "-y");
    this.args.unshift("-y");
    return this;
  }

  /**
   * Copy codecs without re-encoding / Копировать кодеки без перекодирования
   */
  public copyCodecs(): this {
    if (this.args.some((_v, i, arr) => arr[i] === "-c" && arr[i + 1] === "copy")) {
      return this;
    }
    this.args.push("-c", "copy");
    return this;
  }

  /**
   * Create audio crossfade using FFmpeg acrossfade filter.
   * Создать аудио-кроссфейд с помощью FFmpeg-фильтра acrossfade.
   *
   * Note: FFmpeg's acrossfade filter works with exactly 2 inputs at a time.
   * For multiple inputs, use sequential crossfades.
   *
   * Примеры:
   *  fluent
   *    .input(firstUrl)
   *    .input(secondUrl)
   *    .crossfadeAudio(5);                 // 5 секунд кроссфейда
   *
   *  fluent
   *    .input(firstUrl)
   *    .crossfadeAudio(3, { secondInput: secondUrl });
   *
   * @param durationSec Crossfade duration in seconds (длительность в секундах)
   * @param options Crossfade options (опции кроссфейда)
   */
  public crossfadeAudio(durationSec: number, options: CrossfadeAudioOptions = {}): this {
    this.requireClean("crossfadeAudio");

    if (
      durationSec == null ||
      typeof durationSec !== "number" ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0
    ) {
      throw new FluentStreamValidationError(
        "crossfadeAudio: durationSec must be a positive number",
      );
    }

    // При необходимости добавляем второй вход
    if (options.secondInput) {
      const second = options.secondInput;

      if (typeof second === "string") {
        const already = this.args.some((v, i) => v === "-i" && this.args[i + 1] === second);
        if (!already) {
          this.input(second);
        }
      } else {
        // Readable stream: добавляем как новый pipe
        this.input(second, { allowDuplicate: false });
      }
    }

    const counted = this.countInputs();
    const inputs = options.inputs ?? 2;

    if (counted.total < inputs) {
      throw new FluentStreamValidationError(
        `crossfadeAudio: requires at least ${inputs} inputs, but only ${counted.total} configured`,
      );
    }

    // ✅ ИСПРАВЛЕНИЕ: Правильная генерация фильтра
    const { filter } = Processor.buildAcrossfadeFilter({
      inputs,
      duration: durationSec,
      curve1: options.curve1 ?? "tri",
      curve2: options.curve2 ?? "tri",
      inputLabels: options.inputLabels,
      outputLabel: options.outputLabel,
    });

    // Extra фильтры применяются отдельно, не через двоеточие
    if (options.extra && String(options.extra).trim().length > 0) {
      const extraFilter = String(options.extra).trim();
      const outputLbl = options.outputLabel ?? "acf";
      const finalFilter = `${filter};[${outputLbl}]${extraFilter}[${outputLbl}_final]`;
      this.complexFilter(finalFilter);
    } else {
      this.complexFilter(filter);
    }

    return this;
  }

  // ============================================================================
  // PUBLIC API - STATE MANAGEMENT
  // ============================================================================

  /**
   * Add blob input / Добавить blob вход
   *
   * @param blobUrl - Blob URL to resolve (blob URL для разрешения)
   * @param index - Input index (optional) (индекс входа, опционально)
   */
  public inputBlob(blobUrl: string, index?: number): this {
    this.requireClean("inputBlob");

    if (!blobUrl || typeof blobUrl !== "string") {
      throw new FluentStreamValidationError("inputBlob(): blobUrl must be a non-empty string");
    }

    const inputIndex = index ?? this.inputSources.length;
    this.inputSources.push({ type: "blob", blobUrl, index: inputIndex });
    this.args.push("-i", `pipe:${inputIndex}`);

    return this;
  }

  /**
   * Clear all state (required before reuse after .run()) / Очистить всё состояние (требуется перед переиспользованием после .run())
   */
  public clear(): this {
    this.args = [];
    this.inputStreams = [];
    this.inputSources = [];
    this.complexFilters = [];
    this.isDirty = false;
    this.processorResult = null;
    return this;
  }

  /**
   * Reset only arguments / Сбросить только аргументы
   */
  public resetArgs(): this {
    this.args = [];
    this.complexFilters = [];
    return this;
  }

  /**
   * Check if instance is dirty (requires .clear()) / Проверить, "грязно" ли (требует .clear())
   */
  public isDirtyState(): boolean {
    return this.isDirty;
  }

  /**
   * Check if instance is ready for use / Проверить, готово ли к использованию
   */
  public isReady(): boolean {
    return !this.isDirty;
  }

  // ============================================================================
  // PUBLIC API - EXECUTION & INSPECTION
  // ============================================================================

  /**
   * Get copy of current FFmpeg arguments / Получить копию текущих аргументов FFmpeg
   */
  public getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Assemble final FFmpeg arguments with filters / Собрать финальные аргументы FFmpeg с фильтрами
   */
  public assembleArgs(): string[] {
    const finalArgs = [...this.args];

    // Add -filter_complex if filters exist
    if (this.complexFilters.length > 0) {
      let hasFilterComplex = false;

      for (let i = 0; i < finalArgs.length - 1; i++) {
        if (finalArgs[i] === "-filter_complex") {
          hasFilterComplex = true;
          this.emitLog(
            "warn",
            "assembleArgs: Duplicate -filter_complex detected. Using combined filters.",
            { code: "FluentStream-duplicate-filter-complex" },
          );
          break;
        }
      }

      if (!hasFilterComplex) {
        finalArgs.push("-filter_complex", this.complexFilters.join(";"));
      }
    }

    // Add fail-fast flag if enabled
    if (this.options.failFast && !finalArgs.includes("-xerror")) {
      finalArgs.push("-xerror");
    }

    // Add progress tracking if enabled
    if (this.options.enableProgressTracking) {
      if (!finalArgs.some((v, _i, _arr) => v === "-progress")) {
        finalArgs.push("-progress", "pipe:2");
      }
    }

    // Add wall-time limit if specified
    if (typeof this.options.wallTimeLimit === "number" && this.options.wallTimeLimit > 0) {
      finalArgs.push("-timelimit", String(this.options.wallTimeLimit));
    }

    return finalArgs;
  }

  /**
   * Get summary of inputs / Получить краткое описание входов
   */
  public getInputSummary(): {
    stringInputs: string[];
    urlInputs: string[];
    pipeStreams: string[];
    complexFilters: string[];
  } {
    return summarizeInputs(this.args, this.inputStreams, this.complexFilters, this.inputSources);
  }

  /**
   * Count inputs / Подсчитать входы
   */
  public countInputs(): {
    streams: number;
    stringInputs: number;
    urlInputs: number;
    total: number;
  } {
    return countInputs(this.args, this.inputStreams, this.inputSources);
  }

  /**
   * Run FFmpeg process / Запустить процесс FFmpeg
   *
   * WARNING: Instance becomes dirty after this. Call .clear() before reusing!
   * ВНИМАНИЕ: Экземпляр становится "грязным" после этого. Вызовите .clear() перед переиспользованием!
   */
  public async run(extraOpts: Partial<ProcessorOptions> = {}): Promise<FFmpegRunResultExtended> {
    if (this.isDirty) {
      throw new FluentStreamValidationError(
        "FluentStream is dirty — `.clear()` required before next `.run()`",
      );
    }

    const processor = this.createProcessor(extraOpts);
    this.isDirty = true;
    this.processorResult = await processor.run();

    await new Promise((resolve) => setTimeout(resolve, 50));

    return this.processorResult;
  }

  // ============================================================================
  // PUBLIC API - STATIC UTILITIES
  // ============================================================================

  /**
   * Get stdout pipe helper object / Получить helper-объект для stdout
   */
  static get stdout(): { pipe: string } {
    return { pipe: "stdout" };
  }

  /**
   * Get stderr pipe helper object / Получить helper-объект для stderr
   */
  static get stderr(): { pipe: string } {
    return { pipe: "stderr" };
  }

  /**
   * Get pipe:1 helper object / Получить helper-объект для pipe:1
   */
  static get pipe1(): { pipe: "pipe:1" } {
    return { pipe: "pipe:1" };
  }

  /**
   * Get pipe:2 helper object / Получить helper-объект для pipe:2
   */
  static get pipe2(): { pipe: "pipe:2" } {
    return { pipe: "pipe:2" };
  }

  // ============================================================================
  // PUBLIC API - DEBUG UTILITIES
  // ============================================================================

  /**
   * Get string representation for debugging / Получить строковое представление для отладки
   */
  public toString(): string {
    return (
      `[FluentStream dirty=${this.isDirty} ` +
      `inputs=${this.countInputs().total} ` +
      `filters=${this.complexFilters.length} ` +
      `args=${this.args.length}]`
    );
  }

  /**
   * Get detailed debug info / Получить подробную отладочную информацию
   */
  public debugInfo(): {
    isDirty: boolean;
    args: string[];
    inputs: Array<{ stream: string; index: number }>;
    filters: string[];
    audioState: {
      volume: number;
      bass: number;
      treble: number;
      compressor: boolean;
      audioProcessor: boolean;
    };
  } {
    return {
      isDirty: this.isDirty,
      args: [...this.args],
      inputs: this.inputStreams.map((s) => ({
        stream: `Readable[${s.index}]`,
        index: s.index,
      })),
      filters: [...this.complexFilters],
      audioState: {
        volume: this.audioVolume,
        bass: this.audioBass,
        treble: this.audioTreble,
        compressor: this.audioCompressor,
        audioProcessor: this.enabledAudioProcessor,
      },
    };
  }
}
