import { EventEmitter } from "eventemitter3";
import { Readable, Transform, Duplex } from "node:stream";
import Processor from "./Processor.js";
import {
  FFmpegRunResult,
  ProcessorOptions,
  Logger
} from "../Types/index.js";

const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  log: () => {},
  warn: (...args: any[]) => {
    if (process?.emitWarning) process.emitWarning(args[0], { code: args[1]?.code });
    if (args[1]?.stackTrace) {
      // eslint-disable-next-line no-console
      console.warn("Stack (context):", args[1]?.stackTrace);
    }
  },
  error: (...args: any[]) => {
    if (process?.emitWarning) process.emitWarning(args[0], { code: args[1]?.code });
    if (args[1]?.stackTrace) {
      // eslint-disable-next-line no-console
      console.error("Stack (context):", args[1]?.stackTrace);
    }
  },
};

function getStackTrace(skip = 2): string {
  const stack = new Error().stack;
  return stack ? stack.split("\n").slice(skip).filter(l => !l.includes("node:internal")).join("\n") : "";
}

export type EncoderBuilder = (encoder: FluentStream) => void;

class FluentStreamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FluentStreamValidationError";
  }
}
function countInputs(args: string[], inputStreams: Array<{ stream: Readable; index: number }>): {
  streams: number;
  stringInputs: number;
  total: number;
} {
  let stringInputs = 0;
  for (let i = 0; i < args.length - 1; ++i) {
    if (args[i] === "-i") stringInputs++;
  }
  return {
    streams: inputStreams.length,
    stringInputs,
    total: stringInputs + inputStreams.length,
  };
}
function summarizeInputs(args: string[], _inputStreamsArr: Array<{stream: Readable, index: number}>, complexFilters: string[]) {
  const ret: {
    stringInputs: string[],
    pipeStreams: string[],
    complexFilters: string[]
  } = { stringInputs: [], pipeStreams: [], complexFilters: [...complexFilters] };
  for (let i = 0; i < args.length - 1; ++i) {
    if (args[i] === "-i") {
      if (/^pipe:\d+$/.test(args[i + 1])) ret.pipeStreams.push(args[i + 1]);
      else ret.stringInputs.push(args[i + 1]);
    }
  }
  return ret;
}

/**
 * Класс-обёртка для управления потоковым ffmpeg процессом (Fluent API).
 * После .run() объект становится "грязным" (dirty) — до .clear() повторное использование запрещено!
 */
export default class FluentStream extends EventEmitter {
  static HUMANITY_HEADER = Object.freeze({
    "X-Human-Intent": "true",
    "X-Request-Attention": "just-want-to-do-my-best",
    "User-Agent": "FluentStream/1.0 (friendly bot)",
  });

  static logger: {
    warn: (msg: string, opts?: Record<string, any>) => void;
    info: (msg: string, opts?: Record<string, any>) => void;
    error: (msg: string, opts?: Record<string, any>) => void;
    debug: (msg: string, opts?: Record<string, any>) => void;
  } = defaultLogger;

  static _reset(): void {}

  private args: string[] = [];
  private _inputStreams: Array<{ stream: Readable; index: number }> = [];
  private complexFilters: string[] = [];
  public readonly options: ProcessorOptions;
  public _headers: Record<string, string> | undefined;
  private audioTransform: Transform | Duplex | null = null;
  private _logger =
    (this.constructor as typeof FluentStream).logger || defaultLogger;
  private customAudioTransform: Transform | Duplex | null = null;
  private _dirty = false;

  constructor(options: ProcessorOptions = {}) {
    super();
    this.options = { ...options };
    if (typeof options.headers === "object" && options.headers !== null) {
      this._headers = options.headers;
    } else if (options.headers === undefined) {
      this._headers = undefined;
    } else {
      this._headers = {};
    }
  }

  /**
   * Централизованный логгер для предупреждений, ошибок и информации.
   * @param level 'warn' | 'error' | 'info' | 'debug'
   * @param msg Сообщение для журнала
   * @param opts Дополнительные параметры лога
   */
  private emitLog(
    level: "warn" | "error" | "info" | "debug",
    msg: string,
    opts?: Record<string, any>
  ): void {
    const logger = this._logger;
    const options = { ...(opts || {}) };
    if (!options.stackTrace) options.stackTrace = getStackTrace();
    if (typeof logger[level] === "function") {
      logger[level](msg, options);
    }
  }

  /**
   * Экспериментальная функция кастомной обработки аудио-цепочки.
   * Меняет поведение только на период выполнения `fn`, исключает утечки состояний.
   * @param processor Внешний transform/duplex для аудио
   * @param fn Callback-сборщик, вызываемый прокси-encoder API
   */
  public withAudioTransform(
    processor: Transform | Duplex,
    fn: (encoder: {
      input: (input: string | Readable, opts?: { label?: string, pipeIndex?: number, allowDuplicate?: boolean }) => typeof encoder;
      inputOptions: (...opts: string[]) => typeof encoder;
      output: (output: string | Readable | number | { pipe?: string } | undefined | null) => typeof encoder;
      audioCodec: (codec: string) => typeof encoder;
      outputOptions: (...opts: string[]) => typeof encoder;
    }) => void
  ): this {
    if (this._dirty) throw new FluentStreamValidationError("Cannot use .withAudioTransform() after .run() without .clear()");
    if (typeof fn !== "function") throw new FluentStreamValidationError("withAudioTransform expects a function as the second argument");

    const encoder = {
      input: (input: string | Readable, opts?: { label?: string, pipeIndex?: number, allowDuplicate?: boolean }) => {
        this.input(input, opts); return encoder;
      },
      inputOptions: (...opts: string[]) => { this.inputOptions(...opts); return encoder; },
      output: (output: string | Readable | number | { pipe?: string } | undefined | null) => {
        this.output(output); return encoder;
      },
      audioCodec: (codec: string) => { this.audioCodec(codec); return encoder; },
      outputOptions: (...opts: string[]) => { this.outputOptions(...opts); return encoder; }
    };

    const prev = { audio: this.audioTransform, custom: this.customAudioTransform };
    try {
      this.customAudioTransform = this.audioTransform = processor;
      fn(encoder);
    } catch (err) {
      this.customAudioTransform = prev.custom;
      this.audioTransform = prev.audio;
      this.emitLog("error", "[FluentStream] withAudioTransform user error", { err });
      throw err;
    }

    return this;
  }

  /**
   * Установить собственный Transform/duplex как обработчик аудиопотока.
   * @param transform Трансформ-стрим
   * @returns this
   */
  public setAudioTransform(transform: Transform | Duplex): this {
    if (this._dirty) throw new FluentStreamValidationError("Cannot use .setAudioTransform() after .run() without .clear()");
    this.customAudioTransform = transform;
    this.audioTransform = transform;
    return this;
  }

  /**
   * Сбросить пользовательский аудиотрансформ.
   * @returns this
   */
  public clearAudioTransform(): this {
    this.customAudioTransform = null;
    this.audioTransform = null;
    return this;
  }

  /**
   * Установить HTTP-заголовки для ffmpeg-запросов.
   * @returns this
   */
  public setHeaders(headers?: Record<string, string> | null): this {
    this._headers = headers == null ? undefined : headers;
    return this;
  }

  /**
   * Получить итоговые HTTP-заголовки, учитывающие HUMANITY_HEADER.
   */
  public getHeaders(): Record<string, string> {
    return this.getMergedHeaders();
  }

  /**
   * Добавить или заменить HTTP-заголовки (аргумент -headers для ffmpeg).
   * @returns this
   */
  public headers(
    headers?: Record<string, string> | null,
    opts?: { merge?: boolean }
  ): this {
    this._headers = headers == null ? undefined : headers;
    const mergeMode = !!opts?.merge;
    if (!mergeMode) {
      for (let i = 0; i < this.args.length; ) {
        if (this.args[i] === "-headers" && typeof this.args[i + 1] === "string") {
          this.args.splice(i, 2);
        } else i++;
      }
    }
    if (headers && Object.keys(headers).length > 0) {
      const headerString =
        Object.entries(headers)
          .map(([k, v]) => {
            const keyEsc = String(k).replace(/;/g, "\\;");
            const valEsc = String(v).replace(/;/g, "\\;");
            return `${keyEsc}: ${valEsc}`;
          })
          .join("\r\n") + "\r\n";
      const firstInput = this.args.findIndex(a => a === "-i");
      if (firstInput !== -1) {
        this.args.splice(firstInput, 0, "-headers", headerString);
      } else {
        this.args.unshift("-headers", headerString);
      }
    }
    return this;
  }

  /**
   * Добавляет -user_agent для HTTP(S) input (ffmpeg).
   * @returns this
   */
  public userAgent(
    userAgent?: string | null,
    opts?: { merge?: boolean }
  ): this {
    const mergeMode = !!opts?.merge;
    if (!mergeMode) {
      for (let i = 0; i < this.args.length;) {
        if (this.args[i] === "-user_agent" && typeof this.args[i + 1] === "string") {
          this.args.splice(i, 2);
        } else i++;
      }
    }
    if (userAgent && userAgent.length > 0) {
      const firstInput = this.args.findIndex(a => a === "-i");
      if (firstInput !== -1) {
        this.args.splice(firstInput, 0, "-user_agent", userAgent);
      } else {
        this.args.unshift("-user_agent", userAgent);
      }
    }
    const hasHTTPInput =
      this.args.some(
        (v, idx, arr) =>
          v === "-i" &&
          typeof arr[idx + 1] === "string" &&
          /^https?:\/\//.test(arr[idx + 1])
      );
    if (
      userAgent &&
      userAgent.length > 0 &&
      !hasHTTPInput
    ) {
      this.emitLog(
        "warn",
        "userAgent: -user_agent применяется ТОЛЬКО к HTTP/HTTPS входам! ffmpeg проигнорирует -user_agent для других протоколов.",
        { code: "FluentStream-warn-non-http-useragent", detail: userAgent }
      );
    }
    return this;
  }

  /**
   * Сбросить весь накопленный state (обязательно перед повторным .run()).
   */
  public clear(): this {
    this.audioTransform = null;
    this.customAudioTransform = null;
    this.args = [];
    this._inputStreams = [];
    this.complexFilters = [];
    this._dirty = false;
    return this;
  }

  /**
   * Сбросить только аргументы (без потоков).
   */
  public resetArgs(): this {
    this.args = [];
    this.complexFilters = [];
    return this;
  }

  /**
   * Добавить вход для ffmpeg (строка: путь/url либо поток).
   * Безопасно предотвращает дубликаты, гарантирует согласованность потоков.
   * @param input Строка url/путь или поток Readable
   * @param opts Доп. опции
   * @returns this
   */
  public input(
    input: string | Readable | undefined | null,
    opts?: { label?: string, pipeIndex?: number, allowDuplicate?: boolean }
  ): this {
    if (this._dirty) throw new FluentStreamValidationError("Cannot add input after .run() without .clear()");
    if (input == null) {
      throw new FluentStreamValidationError(
        `input(): input must be a non-null string (path/url) or a Readable`
      );
    }
    if (typeof input === "string") {
      if (!opts?.allowDuplicate && this.args.some((v, i) => v === "-i" && this.args[i + 1] === input)) {
        this.emitLog(
          "warn",
          `input(): String input "${input}" already exists in args (skipped duplicate).`,
          { code: "FluentStream-duplicate-string-input" }
        );
        return this;
      }
      this.args.push("-i", input);
    } else if (typeof input.read === "function") {
      // Защита от дублирования pipe index
      let streamIdx: number;
      if (opts?.pipeIndex != null && Number.isFinite(opts.pipeIndex) && opts.pipeIndex >= 0) {
        if (this._inputStreams.some(entry => entry.index === opts.pipeIndex)) {
          throw new FluentStreamValidationError(
            `input(): Attempt to use duplicate pipe index: ${opts.pipeIndex}`
          );
        }
        streamIdx = opts.pipeIndex;
      } else {
        streamIdx = this._inputStreams.length;
      }
      // Запрет дублирования самого потока (по ссылке)
      if (
        !opts?.allowDuplicate &&
        this._inputStreams.some((s) => s.stream === input)
      ) {
        this.emitLog(
          "warn",
          "input(): Provided Readable stream has already been added (skipping duplicate).",
          { code: "FluentStream-duplicate-pipe" }
        );
        return this;
      }
      this._inputStreams.push({ stream: input, index: streamIdx });
      this.args.push("-i", `pipe:${streamIdx}`);
    } else {
      throw new FluentStreamValidationError(
        `input(): input must be string (path/url) or a Readable`
      );
    }
    return this;
  }

  /**
   * Задать выход ffmpeg: строка/pipe-объект.
   * @returns this
   */
  public output(
    output: string | Readable | number | { pipe?: string } | undefined | null
  ): this {
    if (this._dirty) throw new FluentStreamValidationError("Cannot set output after .run() without .clear()");
    if (output && typeof output === "object" && "pipe" in output && output.pipe) {
      const pipeName = output.pipe;
      if (
        pipeName === "stdout" ||
        pipeName === "stderr" ||
        pipeName === "1" ||
        pipeName === "2"
      ) {
        this.args.push(
          "pipe:" +
            (pipeName === "stdout"
              ? "1"
              : pipeName === "stderr"
              ? "2"
              : String(pipeName))
        );
        return this;
      }
      if (typeof pipeName === "string" && /^pipe:\d+$/.test(pipeName)) {
        this.args.push(pipeName);
        return this;
      }
      throw new FluentStreamValidationError(
        "output(): Invalid pipe target: " + String(pipeName)
      );
    }
    if (
      output == null ||
      (typeof output === "string" && output.trim().length === 0)
    ) {
      throw new FluentStreamValidationError(
        "output(): requires a non-empty string/output."
      );
    }
    this.args.push(String(output));
    return this;
  }

  /**
   * Добавить глобальные аргументы ffmpeg (до первого -i).
   * @returns this
   */
  public globalOptions(...opts: string[]): this {
    const firstInputIdx = this.args.findIndex(arg => arg === "-i");
    if (firstInputIdx !== -1) {
      this.args.splice(firstInputIdx, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  /**
   * Добавить опции ffmpeg для входов (перед последним -i).
   * @returns this
   */
  public inputOptions(...opts: string[]): this {
    const idx = this.args.lastIndexOf("-i");
    if (idx !== -1) {
      this.args.splice(idx, 0, ...opts);
    } else {
      this.args.unshift(...opts);
    }
    return this;
  }

  /**
   * Добавить опции ffmpeg для выхода (после остальных аргументов).
   * @returns this
   */
  public outputOptions(...opts: string[]): this {
    this.args.push(...opts);
    return this;
  }

  /**
   * Установить видео-кодек.
   * @returns this
   */
  public videoCodec(codec: string): this {
    if (codec) this.args.push("-c:v", codec);
    return this;
  }

  /**
   * Установить аудиокодек.
   * @returns this
   */
  public audioCodec(codec: string): this {
    if (codec) this.args.push("-c:a", codec);
    return this;
  }

  /**
   * Задать bitrate для видео.
   * @returns this
   */
  public videoBitrate(bitrate: string): this {
    this.args.push("-b:v", bitrate);
    return this;
  }

  /**
   * Задать bitrate для аудио.
   * @returns this
   */
  public audioBitrate(bitrate: string): this {
    this.args.push("-b:a", bitrate);
    return this;
  }

  /**
   * Принудительно задать формат.
   * @returns this
   */
  public format(format: string): this {
    for (let i = 0; i < this.args.length - 1;) {
      if (this.args[i] === "-f") {
        this.args.splice(i, 2);
      } else i++;
    }
    this.args.push("-f", format);
    return this;
  }

  /**
   * Ограничить длительность трека.
   * @returns this
   */
  public duration(time: string | number): this {
    this.args.push("-t", String(time));
    return this;
  }

  /**
   * Отключить видео-дорожку.
   * @returns this
   */
  public noVideo(): this {
    this.args.push("-vn");
    return this;
  }

  /**
   * Отключить аудио-дорожку.
   * @returns this
   */
  public noAudio(): this {
    this.args.push("-an");
    return this;
  }

  /**
   * Установить частоту дискретизации.
   * @returns this
   */
  public audioFrequency(freq: number): this {
    this.args.push("-ar", String(freq));
    return this;
  }

  /**
   * Установить количество каналов.
   * @returns this
   */
  public audioChannels(channels: number): this {
    this.args.push("-ac", String(channels));
    return this;
  }

  /**
   * Прямое копирование кодеков (без перекодирования).
   * @returns this
   */
  public copyCodecs(): this {
    if (
      this.args.some((_v, i, arr) => arr[i] === "-c" && arr[i + 1] === "copy")
    ) {
      return this;
    }
    this.args.push("-c", "copy");
    return this;
  }

  /**
   * Добавить комплексный фильтр (или несколько) к ffmpeg.
   * @returns this
   */
  public complexFilter(graph: string | string[]): this {
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
   * Вставить acrossfade фильтр crossfadeAudio с параметрами.
   * @param duration длительность в секундах
   * @param opts опции crossfade
   * @returns this
   */
  public crossfadeAudio(
    duration: number,
    opts?: {
      c1?: string;
      c2?: string;
      curve1?: string;
      curve2?: string;
      additional?: string;
      input2?: string | Readable;
      nb_samples?: number;
      overlap?: boolean;
      inputLabels?: string[];
      outputLabel?: string;
      inputs?: number;
      input2Label?: string;
      allowDuplicateInput2?: boolean;
    },
  ): this {
    if (this._dirty) throw new FluentStreamValidationError("Cannot use .crossfadeAudio() after .run() without .clear()");
    if (
      duration == null ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new FluentStreamValidationError("crossfadeAudio: duration must be a positive number.");
    }
    // Добавить второй источник при необходимости.
    if (opts?.input2) {
      let alreadyPresent = false;
      if (typeof opts.input2 === "string") {
        alreadyPresent = this.args.some(
          (v, i) => v === "-i" && this.args[i + 1] === opts.input2
        );
      } else if (opts.input2 && typeof (opts.input2).read === "function") {
        alreadyPresent = this._inputStreams.some(ent => ent.stream === opts.input2);
      }
      if (!alreadyPresent || opts.allowDuplicateInput2) {
        this.input(opts.input2, {
          allowDuplicate: opts.allowDuplicateInput2,
          label: opts.input2Label
        });
      }
    }
    // Проверка количества входов
    const counted = countInputs(this.args, this._inputStreams);
    const expectedInputs = opts?.inputs ?? 2;
    if (counted.total < expectedInputs) {
      throw new FluentStreamValidationError(
        `crossfadeAudio requires at least ${expectedInputs} inputs (current: ${counted.total}).`
      );
    }
    // Генерация фильтра
    const { filter } = Processor.buildAcrossfadeFilter({
      inputs: expectedInputs,
      duration,
      curve1: opts?.curve1 ?? opts?.c1 ?? "tri",
      curve2: opts?.curve2 ?? opts?.c2 ?? "tri",
      nb_samples: opts?.nb_samples,
      overlap: opts?.overlap,
      inputLabels: opts?.inputLabels,
      outputLabel: opts?.outputLabel,
    });
    let filterStr = filter;
    if (opts?.additional && String(opts.additional).trim()) {
      filterStr += `:${String(opts.additional).trim()}`;
    }
    this.complexFilters.push(filterStr);

    return this;
  }

  /**
   * Получить копию текущего массива CLI-аргументов ffmpeg.
   */
  public getArgs(): string[] {
    return [...this.args];
  }

  public isDirty(): boolean {
    return this._dirty;
  }

  public isReady(): boolean {
    return !this._dirty;
  }

  public toString(): string {
    return `[FluentStream dirty=${this._dirty} inputs=${this._inputStreams.length} args=${this.args.length}]`;
  }

  /**
   * Получить краткое описание входов.
   */
  public getInputSummary(): {stringInputs: string[], pipeStreams: string[], complexFilters: string[]} {
    return summarizeInputs(this.args, this._inputStreams, this.complexFilters);
  }

  /**
   * Собрать "чистый" перечень аргументов для запуска Processor/ffmpeg.
   * Не вставляет дубликатов фильтров!
   */
  public assembleArgs(): string[] {
    const finalArgs = [...this.args];

    // -filter_complex, если фильтры есть
    const filterComplexes: string[] = [];
    if (this.complexFilters.length) {
      // Количество -filter_complex в исходных args
      let manualIdx = -1;
      for (let i = 0; i < finalArgs.length - 1; i++) {
        if (finalArgs[i] === "-filter_complex") {
          manualIdx = i;
          filterComplexes.push(finalArgs[i + 1]);
        }
      }
      if (manualIdx >= 0) {
        this.emitLog(
          "warn",
          "assembleArgs: Дублирование -filter_complex! Убедитесь, что не добавляете вручную -filter_complex в args при использовании complexFilter/crossfadeAudio. Будут использованы ВСЕ -filter_complex для FFmpeg (поведение не гарантировано).",
          {
            code: "FluentStream-DuplicateFilterComplex",
            currentArgs: [...finalArgs],
            complexFilters: [...this.complexFilters]
          }
        );
      } else {
        finalArgs.push("-filter_complex", this.complexFilters.join(";"));
      }
    }

    if (this.options.failFast && !finalArgs.includes("-xerror")) {
      finalArgs.push("-xerror");
    }

    // -progress
    const progressIdx = finalArgs.findIndex(a => a === "-progress");
    if (this.options.enableProgressTracking) {
      if (progressIdx === -1) {
        finalArgs.push("-progress", "pipe:2");
      } else {
        this.emitLog(
          "warn",
          "assembleArgs: Дублирование -progress! (лучше использовать только API, а не вручную)",
          { code: "FluentStream-DuplicateProgress", currentArgs: [...finalArgs] }
        );
      }
    }

    // -timelimit (wallTimeLimit)
    if (
      typeof this.options.wallTimeLimit === "number" &&
      this.options.wallTimeLimit > 0
    ) {
      finalArgs.push("-timelimit", String(this.options.wallTimeLimit));
    }
    return finalArgs;
  }

  /**
   * Получить итоговый набор заголовков: пользовательские или HUMANITY_HEADER.
  */
  private getMergedHeaders(): Record<string, string> {
    if (!this._headers) return { ...FluentStream.HUMANITY_HEADER };
    return Object.keys(this._headers).length > 0 ? { ...this._headers } : {};
  }

  private addHumanityHeadersToProcessorOptions(
    options: ProcessorOptions,
  ): ProcessorOptions {
    const mergedHeaders = this.getMergedHeaders();
    return { ...options, headers: mergedHeaders };
  }

  /**
   * Подготавливает Processor со всеми аргументами/потоками (только для внутреннего запуска).
   */
  private createProcessor(
    extraOpts: Partial<ProcessorOptions> = {},
    args?: string[],
    inputStreams?: Array<{ stream: Readable; index: number }>,
  ) {
    const opts = this.addHumanityHeadersToProcessorOptions({
      ...this.options,
      ...extraOpts,
    });
    if (inputStreams && inputStreams.length > 0) {
      (opts).inputStreams = inputStreams;
    } else if (this._inputStreams && this._inputStreams.length > 0) {
      (opts).inputStreams = this._inputStreams;
    }
    return Processor.create({
      args: args ?? this.assembleArgs(),
      options: opts,
    });
  }

  /**
   * Запустить ffmpeg с текущими аргументами/потоками.
   * После вызова становится dirty, повторное использование невозможно — нужно clear()!
   */
  public run(extraOpts: Partial<ProcessorOptions> = {}): FFmpegRunResult {
    if (this._dirty) {
      throw new FluentStreamValidationError(
        "FluentStream instance is dirty: .clear() must be called before next .run()!"
      );
    }
    const proc = this.createProcessor(extraOpts);
    this._dirty = true;
    return proc.run();
  }

  /**
   * Принудительно разрешить overwrite (-y) первым аргументом.
   * @returns this
   */
  public overwrite(): this {
    this.args = this.args.filter((arg) => arg !== "-y");
    this.args.unshift("-y");
    return this;
  }

  /**
   * Добавить -map спецификацию.
   * @returns this
   */
  public map(mapSpec: string): this {
    this.args.push("-map", mapSpec);
    return this;
  }

  /**
   * Установить позицию seek для входа.
   * @returns this
   */
  public seekInput(position: number | string): this {
    if (
      position == null ||
      (typeof position === "string" && !position.trim())
    ) {
      throw new FluentStreamValidationError(
        "seekInput: position must be non-empty string or number"
      );
    }
    const firstInputIdx = this.args.findIndex((arg) => arg === "-i");
    if (firstInputIdx === -1) {
      this.args.unshift("-ss", String(position));
    } else {
      this.args.splice(firstInputIdx, 0, "-ss", String(position));
    }
    return this;
  }

  /**
   * Получить аудио Transform/duplex, учитывая кастомный, если задан.
   */
  public getAudioTransform(): Transform | Duplex {
    if (this.customAudioTransform) {
      return this.customAudioTransform;
    }
    if (!this.audioTransform) {
      throw new FluentStreamValidationError(
        "No audio transform pipeline exists: .setAudioTransform() must be called before getAudioTransform()."
      );
    }
    const t = this.audioTransform as Transform & { _backpressureWarned?: boolean; _writableState?: any; _readableState?: any };
    if (
      typeof t._backpressureWarned === "undefined"
      && typeof t._writableState === "object"
      && typeof t._readableState === "object"
    ) {
      t._backpressureWarned = true;
      const readableState = t._readableState;
      if (readableState && readableState.highWaterMark > 128 * 1024) {
        this.emitLog(
          "warn",
          `getAudioTransform(): Potentially large stream buffer (highWaterMark: ${readableState.highWaterMark}). If running multiple big inputs or complex crossfade, monitor node memory/latency.`,
          { code: "FluentStream-backpressure" }
        );
      }
    }
    return this.audioTransform;
  }

  /** Объект для pipe:1 (stdout) */
  static get stdout(): { pipe: string } {
    return { pipe: "stdout" };
  }
  /** Объект для pipe:2 (stderr) */
  static get stderr(): { pipe: string } {
    return { pipe: "stderr" };
  }
  /** Объект для pipe:1 (stdout) */
  static get pipe1(): { pipe: "pipe:1" } {
    return { pipe: "pipe:1" };
  }
  /** Объект для pipe:2 (stderr) */
  static get pipe2(): { pipe: "pipe:2" } {
    return { pipe: "pipe:2" };
  }
}
