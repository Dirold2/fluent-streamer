import { EventEmitter } from "eventemitter3";
import { Readable, Writable, PassThrough, pipeline } from "stream";
import { execa, type Subprocess } from "execa";
import type {
  Logger,
  FFmpegProgress,
  FFmpegRunResultExtended,
} from "../Types/index.js";
import { ProcessorOptions } from "../Types/index.js";

/** 
 * Утилита экранирования параметров для фильтров FFmpeg 
 */
function escapeParam(val: string | number | undefined): string | number | undefined {
  if (typeof val !== "string") return val;
  return val.replace(/[:=]/g, (m) => "\\" + m);
}

/**
 * Processor - управляет жизненным циклом ffmpeg-процесса, потоками ввода/вывода,
 * гарантирует корректное закрытие output для предотвращения "Premature close",
 * позволяет управлять треком (skip/stop).
 *
 * Исправление: после завершения ffmpeg доступен вызов run() ещё раз.
 */
export class Processor extends EventEmitter {
  private process: Subprocess | null = null;
  private passthrough: PassThrough | null = null;
  private outputStream: PassThrough | null = null;
  private blackholeStream: Writable | null = null;
  private inputStreams: Array<{ stream: Readable; index: number }> = [];
  private extraOutputs: Array<{ stream: Writable; index: number }> = [];
  private stderrBuffer = "";
  private isTerminating = false;
  private hasFinished = false;
  private isClosed = false;
  private timeoutHandle?: NodeJS.Timeout;
  private progress: Partial<FFmpegProgress> = {};

  private doneResolve!: () => void;
  private doneReject!: (err: Error) => void;
  private donePromise: Promise<void> | null = null;

  private readonly config: Required<Omit<ProcessorOptions, "abortSignal">> & {
    abortSignal?: AbortSignal;
    logger: Logger;
    verbose?: boolean;
  };

  private args: string[] = [];
  private extraGlobalArgs: string[] = [];

  // Run-state
  private _runEnded: boolean = false;
  private _runEmittedEnd: boolean = false;
  private _doEndSequence: (() => void) | null = null;
  private _pendingProcessExitLog: (() => void) | null = null;

  public get pid(): number | null {
    return this.process?.pid ?? null;
  }

  constructor(options: ProcessorOptions = {}) {
    super();

    this.config = {
      ffmpegPath: options.ffmpegPath ?? "ffmpeg",
      failFast: options.failFast ?? false,
      extraGlobalArgs: options.extraGlobalArgs ?? [],
      loggerTag: options.loggerTag ?? `ffmpeg_${Date.now()}`,
      inputStreams: options.inputStreams ?? [],
      onBeforeChildProcessSpawn: options.onBeforeChildProcessSpawn ?? (() => {}),
      stderrLogHandler: options.stderrLogHandler ?? (() => {}),
      executionId: options.executionId ?? (Math.random().toString(36).slice(2) + Date.now()),
      wallTimeLimit: options.wallTimeLimit ?? 0,
      timeout: options.timeout ?? 0,
      maxStderrBuffer: options.maxStderrBuffer ?? 1024 * 1024,
      enableProgressTracking: options.enableProgressTracking ?? false,
      logger: (options.logger as Logger) ?? console,
      debug: options.debug ?? false,
      verbose: (options as any).verbose ?? false,
      suppressPrematureCloseWarning: options.suppressPrematureCloseWarning ?? false,
      abortSignal: options.abortSignal,
      headers: options.headers ?? {},
    };

    this.extraGlobalArgs = [...this.config.extraGlobalArgs];

    this._initPromise();

    this._handleAbortSignal();
  }

  private _initPromise() {
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
  }

  // -----------------------------------------------
  // Публичные методы управления
  // -----------------------------------------------

  public setArgs(args: string[]): this {
    this.args = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public getArgs(): string[] {
    return [...this.args];
  }

  public setInputStreams(streams: Array<{ stream: Readable; index: number }>): this {
    this.inputStreams = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  public getInputStream(): NodeJS.WritableStream | undefined {
    // Correct return type: never return null, only undefined or the stream
    return this.process?.stdin ?? undefined;
  }

  public setExtraOutputStreams(streams: Array<{ stream: Writable; index: number }>): this {
    this.extraOutputs = Array.isArray(streams) ? [...streams] : [];
    return this;
  }

  public setExtraGlobalArgs(args: string[]): this {
    this.extraGlobalArgs = Array.isArray(args) ? [...args] : [];
    return this;
  }

  public getFullArgs(): string[] {
    return [...this.extraGlobalArgs, ...this.args];
  }

  /**
   * Проверка, выполняется ли процесс в данный момент.
   * @returns {boolean}
   */
  public isRunning(): boolean {
    return !!this.process && !this.hasFinished;
  }

  /** Вернуть текущий прогресс ffmpeg (для UI). */
  public getProgress(): Partial<FFmpegProgress> {
    return { ...this.progress };
  }

  /** Public reset: полностью сбросить внутреннее состояние процессора, позволяя повторный запуск. */
  public reset(): void {
    this._resetRunState();
  }

  /**
   * Запустить новый процесс ffmpeg. Логирует старт процесса при debug/verbose.
   * Повторные вызовы run() гарантировано очищают активные потоки и таймеры.
   * Тип результата: FFmpegRunResultExtended.
   */
  public run(): FFmpegRunResultExtended {
    if (this.process) throw new Error("FFmpeg process is already running");

    // Перед запуском - гарантированное уничтожение предыдущих потоков и тайм-аутов.
    this._resetRunState();
    this._initPromise();

    // Логгер
    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Starting ffmpeg process: ${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`
      );
    }

    // Сбор аргументов, запуск сабпроцесса (try/catch для синхронных эксепшнов)
    const fullArgs = this.getFullArgs();

    try {
      this.process = execa(this.config.ffmpegPath, fullArgs, {
        reject: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      });
    } catch (ex) {
      // Синхронная ошибка запуска (например, ffmpeg не найден)
      this.config.logger.error?.(
        `[${this.config.loggerTag}] Failed to spawn ffmpeg: ${(ex as Error).message}`
      );
      this._finalize(ex as Error);
      throw ex;
    }

    this._handleTimeout();
    this._bindInputStream();

    // Tee для мульти-аутов, passthrough для API
    let output: PassThrough = this.process.stdout
      ? (this.extraOutputs.length ? new PassThrough() : (this.process.stdout as PassThrough))
      : new PassThrough();

    if (this.extraOutputs.length) {
      const teeHub = new PassThrough();
      pipeline(this.process.stdout!, teeHub, (err) => {
        if (err && !/premature close/i.test(err.message)) this.emit("error", err);
      });
      for (const { stream } of this.extraOutputs) {
        if (stream && typeof stream.write === "function") teeHub.pipe(stream, { end: false });
      }
      output = teeHub;
    }

    const passthrough = new PassThrough();
    this.outputStream = output;
    this.passthrough = passthrough;
    this._ensureOutputDrained();

    if (this.process.stderr) {
      this.process.stderr.on("data", (chunk) => this._handleStderr(chunk));
    }

    this.process.once("exit", (code, signal) => {
      this._pendingProcessExitLog = () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${this.config.loggerTag}] Process exited with code ${code}, signal ${signal}`
          );
        }
      };
      this._onProcessExit(code, signal);
    });
    this.process.once("error", (err: Error) => {
      this.config.logger.error?.(
        `[${this.config.loggerTag}] Process error: ${err.message}`
      );
      this.emit("error", err);
      this._finalize(err);
    });

    output.on("data", (chunk) => passthrough.write(chunk));

    output.on("end", () => {
      this._runEnded = true;
      if (this._doEndSequence && !this._runEmittedEnd) {
        this._doEndSequence();
      }
    });

    output.on("close", () => {
      if (!this._runEnded && this._doEndSequence && !this._runEmittedEnd) {
        this._runEnded = true;
        setImmediate(() => {
          if (this._doEndSequence && !this._runEmittedEnd) {
            this._doEndSequence();
          }
        });
      }
    });

    // Финализация через _doEndSequence: он будет вызван только если НЕ было close() или завершения
    this._doEndSequence = () => {
      if (this._runEmittedEnd) return;
      if (this.hasFinished || this.isClosed) return;
      this._runEmittedEnd = true;

      const buffer = this.createSilenceBuffer(100, undefined, undefined);

      const finalize = () => {
        passthrough.end();
        setImmediate(() => {
          this.emit('end');
          if (this._pendingProcessExitLog) {
            this._pendingProcessExitLog();
            this._pendingProcessExitLog = null;
          }
          this._finalize();
        });
      };

      try {
        if (!this.hasFinished && !this.isClosed && this.passthrough && !this.passthrough.destroyed) {
          const written = passthrough.write(buffer);
          if (!written) {
            passthrough.once('drain', finalize);
          } else {
            setImmediate(finalize);
          }
        } else {
          setImmediate(finalize);
        }
      } catch (err) {
        setImmediate(finalize);
      }
    };

    this.donePromise!.catch((err) => {
      this.emit("error", err);
      if (!this._runEmittedEnd && this.passthrough && !this.passthrough.destroyed) {
        this.passthrough.destroy(err);
      }
    });

    // Do NOT include passthrough in the return object: it's not part of FFmpegRunResultExtended
    return {
      output: passthrough,
      passthrough,
      done: this.donePromise!,
      stop: () => this.kill(),
      close: () => this.close(),
    };
  }

  /**
   * Мягкое закрытие для раннего завершения (skip/stop/downstream close).
   * Гарантирует безопасное завершение всех потоков.
   *
   * При close() — ставим _runEmittedEnd=true, чтобы _doEndSequence не писал tail.
   */
  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this._runEmittedEnd = true;
    if (this.passthrough && !this.passthrough.destroyed) {
      this.passthrough.end();
      this.passthrough.destroy();
    }
    this.outputStream?.destroy();
    if (this.config.debug || this.config.verbose) {
      this.config.logger.debug?.(
        `[${this.config.loggerTag}] Closed processor stream via .close()`
      );
    }
    await this.kill();
    await this.donePromise;
    this._finalize();
  }

  /**
   * Принудительное завершение процесса ffmpeg (например, skip/stop трека).
   */
  public async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process && !this.isTerminating) {
      this.isTerminating = true;
      if (this.config.debug || this.config.verbose) {
        this.config.logger.debug?.(
          `[${this.config.loggerTag}] Killing process with signal ${signal}`
        );
      }
      this.process.kill(signal);
    }
    if (this.donePromise) {
      try {
        await this.donePromise;
      } catch (_) {
        // проглотить ошибку для kill
      }
    }
  }

  /**
   * Принудительное уничтожение процесса и всех ресурсов. После destroy нельзя использовать экземпляр!
   */
  public destroy(): void {
    this.config.logger?.warn?.(
      `[${this.config.loggerTag}] Processor force destroy() called at ${new Date().toISOString()}`
    );
    this.kill("SIGKILL");
    this._finalize(new Error("Destroyed by user"));
    this.removeAllListeners();
  }

  /**
   * Синтаксический сахар для кроссфейда (перспектива — вынести в отдельный utils).
   * Параметры с : или = экранируются.
   */
  public static buildAcrossfadeFilter(
    opts: {
      inputs?: number;
      nb_samples?: number;
      duration?: number | string;
      overlap?: boolean;
      curve1?: string;
      curve2?: string;
      inputLabels?: string[];
      outputLabel?: string;
    } = {},
  ): { filter: string; outputLabel?: string } {
    let filter = "acrossfade";
    let hasParam = false;
    const add = (key: string, val: string | number | undefined) => {
      if (val === undefined || val === "") return;
      filter += (hasParam ? ":" : "=") + key + "=" + escapeParam(val);
      hasParam = true;
    };
    add("d", opts.duration);
    add("c1", opts.curve1 ?? "tri");
    add("c2", opts.curve2 ?? "tri");
    add("ns", opts.nb_samples);
    if (opts.overlap === false) add("o", 0);
    if (opts.inputs && opts.inputs !== 2) add("n", opts.inputs);
    if (opts.outputLabel && opts.outputLabel.length) {
      filter += `[${opts.outputLabel}]`;
      return { filter, outputLabel: opts.outputLabel };
    }
    return { filter };
  }

  public toString(): string {
    return `${this.config.ffmpegPath} ${this.getFullArgs().join(" ")}`;
  }

  /**
   * Дамп состояния процессора для отладки/логирования.
   */
  public debugDump() {
    return {
      pid: this.pid,
      args: this.getArgs(),
      fullArgs: this.getFullArgs(),
      isClosed: this.isClosed,
      hasFinished: this.hasFinished,
      isTerminating: this.isTerminating,
      running: !!this.process,
      runEnded: this._runEnded,
      runEmittedEnd: this._runEmittedEnd,
      extraGlobalArgs: [...this.extraGlobalArgs],
      stderrBufferLength: this.stderrBuffer.length,
      timeoutHandle: !!this.timeoutHandle,
      progress: { ...this.progress },
      inputStreamsCount: this.inputStreams.length,
      extraOutputsCount: this.extraOutputs.length,
      timestamp: new Date().toISOString(),
    };
  }

  // ----------------------------------
  // PRIVATE utils & helpers
  // ----------------------------------

  private _resetRunState() {
    // Сбросить состояниe для возможности повторных запусков
    // Очистить старый output drain флаг, если был поток
    if (this.outputStream && (this.outputStream as any)._ffmpegDrainAttached) {
      delete (this.outputStream as any)._ffmpegDrainAttached;
    }

    this._runEnded = false;
    this._runEmittedEnd = false;
    this._pendingProcessExitLog = null;
    this.isClosed = false;
    this.hasFinished = false;
    this.isTerminating = false;
    this.stderrBuffer = "";
    this.progress = {};
    // streams будут пересозданы в run()
    this.process = null;
    this.outputStream = null;
    this.passthrough = null;
    this.blackholeStream = null;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  private _getBlackholeStream(): Writable {
    if (this.blackholeStream) return this.blackholeStream;
    this.blackholeStream = new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
    return this.blackholeStream;
  }

  /**
   * Обеспечивает drian output-потока для избежания “Broken pipe”,
   * если потребитель output не читает stream.
   * Не подключает blackholeStream, если поток уже читается.
   */
  private _ensureOutputDrained() {
    if (!this.outputStream) return;
    if ((this.outputStream as any)._ffmpegDrainAttached) return;

    let actuallyRead = false;
    const markRead = () => {
      actuallyRead = true;
      (this.outputStream as any)._ffmpegDrainAttached = true;
    };

    const events = ["data", "readable", "end", "close"];
    let timer: NodeJS.Timeout | undefined;
    const isBeingRead = () => {
      const listeners = (this.outputStream as any).listeners?.("data") ?? [];
      // если есть пользовательские обработчики (кроме наших служебных)
      return listeners.length > 1;
    };

    const maybeDrain = () => {
      if (
        !actuallyRead &&
        this.outputStream &&
        !(this.outputStream as any)._ffmpegDrainAttached &&
        !isBeingRead()
      ) {
        (this.outputStream as any)._ffmpegDrainAttached = true;
        this.outputStream.pipe(this._getBlackholeStream());
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${this.config.loggerTag}] Output PassThrough drained to blackhole to prevent Broken pipe`
          );
        }
      }
    };

    events.forEach((ev) => this.outputStream!.once(ev, markRead));
    this.outputStream.once("newListener", (event: string) => {
      if (events.includes(event)) {
        markRead();
        if (timer) clearTimeout(timer);
      }
    });
    // Увеличить таймер до 100мс
    timer = setTimeout(maybeDrain, 100);
  }

  /** Создаёт Readable с тишиной — для совместимости */
  public createSilenceMs(durationMs = 100, sampleRate = 48000, channels = 2) {
    const buffer = this.createSilenceBuffer(durationMs, sampleRate, channels);
    return new Readable({
      read() {
        this.push(buffer);
        this.push(null);
      },
    });
  }

  /** Создаёт Buffer silence для короткого tail в конец потока */
  public createSilenceBuffer(durationMs = 100, sampleRate = 48000, channels = 2): Buffer {
    const bytesPerSample = 2;
    const totalBytes = Math.floor(
      (durationMs / 1000) * sampleRate * channels * bytesPerSample
    );
    return Buffer.alloc(totalBytes, 0);
  }

  /** Обработка abortSignal — cancels процесс */
  private _handleAbortSignal(): void {
    const { abortSignal } = this.config;
    if (!abortSignal) return;
    const onAbort = () => this.kill("SIGTERM");
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  /** Таймаут жизни процесса */
  private _handleTimeout(): void {
    if (!this.config.timeout) return;
    this.timeoutHandle = setTimeout(() => {
      if (this.config.debug || this.config.verbose) {
        this.config.logger.warn?.(
          `[${this.config.loggerTag}] Process timeout after ${this.config.timeout}ms. Terminating.`
        );
      }
      this.kill("SIGKILL");
    }, this.config.timeout);
  }

  /** Привязка всех input-потоков из this.inputStreams. index=0 -> stdin, прочие — blackhole */
  private _bindInputStream(): void {
    if (!this.inputStreams.length || !this.process?.stdin) return;

    // Для index === 0 привязываем к stdin, остальные pipe в blackhole для скорости drain
    for (const { stream, index } of this.inputStreams) {
      if (!stream) continue;
      stream.on("error", (err) => {
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Input stream error [index=${index}]: ${(err as Error).message}`
        );
        this.emit("error", err);
        this._finalize(err as Error);
      });

      stream.on("end", () => {
        if (this.config.debug || this.config.verbose) {
          this.config.logger.debug?.(
            `[${this.config.loggerTag}] Input stream ended [index=${index}]`
          );
        }
      });

      if (index === 0) {
        pipeline(stream, this.process.stdin, (err) => {
          if (err) {
            if (
              (err as any).code === "EPIPE" &&
              (this.hasFinished || this.isTerminating)
            ) {
              return;
            }
            this.config.logger.error?.(
              `[${this.config.loggerTag}] Input pipeline failed [index=0]: ${(err as Error).message}`
            );
            this.emit("error", err);
            this._finalize(err as Error);
          }
        });
      } else {
        // Просто дреним дополнительные input-ы
        pipeline(stream, this._getBlackholeStream(), () => {});
      }
    }
  }

  /** Обработка stderr ffmpeg, трекинг прогресса */
  private _handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    if (this.stderrBuffer.length < this.config.maxStderrBuffer) {
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > this.config.maxStderrBuffer) {
        this.stderrBuffer = this.stderrBuffer.slice(
          this.stderrBuffer.length - this.config.maxStderrBuffer
        );
      }
    }
    if (this.config.enableProgressTracking) {
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line && line.includes("=")) {
          const progress = this._parseProgress(line);
          if (progress) {
            this.progress = { ...this.progress, ...progress };
            this.emit("progress", { ...this.progress });
          }
        }
      }
    }
  }

  /** Хендлер выхода процесса */
  private _onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.hasFinished) return;
    if (code === 0 || (signal !== null && this.isTerminating)) {
      if (this.isTerminating) {
        this.emit("terminated", signal ?? "SIGTERM");
      }
      // DX: Логгируем успешное завершение (info)
      this.config.logger.info?.(
        `[${this.config.loggerTag}] Process exited normally with code ${code}, signal ${signal} at ${new Date().toISOString()}`
      );

      if (!this._runEmittedEnd) {
        this._runEnded = true;
        setImmediate(() => this._doEndSequence && !this._runEmittedEnd && this._doEndSequence());
      }
    } else {
      // Логировать tail stderr через logger.error при ошибке выхода процесса
      const error = this._getProcessExitError(code, signal);
      const tail = this.stderrBuffer.trim().slice(-4000);
      if (tail && (this.config.debug || this.config.verbose)) {
        this.config.logger.error?.(
          `[${this.config.loggerTag}] Process exited abnormally, stderr tail:\n${tail}`
        );
      }
      this.emit("error", error);
      this._finalize(error);
    }
  }

  /** Создание ошибки по exit процесса */
  private _getProcessExitError(
    code: number | null,
    signal: NodeJS.Signals | null
  ): Error {
    const stderrSnippet = this.stderrBuffer.trim().slice(-1000);
    let message = `FFmpeg exited with code ${code}`;
    if (signal) message += ` (signal ${signal})`;
    if (stderrSnippet) {
      message += `.\nLast stderr output:\n${stderrSnippet}`;
    }
    return new Error(message);
  }

  /** Финализация и cleanup. Обязательно обнуляет поля даже при ошибках. 
   * Безопасен к двойному вызову (guard по hasFinished).
   */
  private _finalize(error?: Error): void {
    if (this.hasFinished) return; // Guard: do not finalize twice!
    this.hasFinished = true;
    try {
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      this._cleanup();
      if (error) {
        // Только при первом вызове трогаем промис
        this.doneReject(error);
      } else {
        this.doneResolve();
      }
    } finally {
      // Всегда обнуляем поля даже при ошибках
      this.process = null;
      this.outputStream = null;
      this.passthrough = null;
      this.blackholeStream = null;
      this.timeoutHandle = undefined;
    }
  }

  /** Очистка потоков и ресурсов, включая timeoutHandle. */
  private _cleanup(): void {
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    this.outputStream?.destroy();
    this.passthrough?.destroy();
    this.blackholeStream?.destroy();
    for (const { stream } of this.extraOutputs) {
      stream.destroy();
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  /** Унифицированный парсер прогресса ffmpeg: все числовые поля приводятся к number. */
  private _parseProgress(line: string): Partial<FFmpegProgress> | null {
    const progress: Partial<FFmpegProgress> = {};
    const pairs = line.trim().split(/\s+/);
    for (const pair of pairs) {
      const [key, value] = pair.split("=", 2);
      if (!key || value == null) continue;
      switch (key) {
        case "frame":
          (progress as any)["frame"] = Number(value);
          break;
        case "total_size":
          (progress as any)["totalSize"] = Number(value);
          break;
        case "out_time_us":
          (progress as any)["outTimeUs"] = Number(value);
          break;
        case "dup_frames":
          (progress as any)["dupFrames"] = Number(value);
          break;
        case "drop_frames":
          (progress as any)["dropFrames"] = Number(value);
          break;
        case "packet":
          (progress as any)["packet"] = Number(value);
          break;
        case "chapter":
          (progress as any)["chapter"] = Number(value);
          break;
        case "fps":
          (progress as any)["fps"] = parseFloat(value.replace("x", ""));
          break;
        case "speed":
          (progress as any)["speed"] = parseFloat(value.replace("x", ""));
          break;
        case "bitrate":
          (progress as any)["bitrate"] = value;
          break;
        case "size":
          (progress as any)["size"] = value;
          break;
        case "out_time":
          (progress as any)["outTime"] = value;
          break;
        case "progress":
          (progress as any)["progress"] = value;
          break;
        case "time":
          (progress as any)["time"] = value;
          break;
      }
    }
    return Object.keys(progress).length > 0 ? progress : null;
  }

  // ----------------------------------
  // STATIC 생성 & helpers
  // ----------------------------------

  /**
   * Быстрое создание экземпляра Processor для пайплайна.
   *
   * Пример:
   *   const proc = Processor.create({
   *     args: ["-i", "file.mp3", "-filter:a", "volume=0.5", "out.wav"],
   *     inputStreams: [],
   *     options: { ffmpegPath: "/usr/bin/ffmpeg" }
   *   });
   */
  static create(params?: {
    args?: string[];
    inputStreams?: Array<{ stream: Readable; index: number }>;
    options?: ProcessorOptions;
  } & ProcessorOptions): Processor {
    if (!params || typeof params !== "object") return new Processor();

    // Защитное копирование и типизация, без мутаций исходных объектов
    let workerArgs: string[] | undefined;
    let workerInputStreams: Array<{ stream: Readable; index: number }> | undefined;
    let optionsObj: ProcessorOptions | undefined;
    // 'rest' variable removed, as it's never used.

    if (Array.isArray(params.args)) {
      workerArgs = [...params.args];
    }
    if (Array.isArray(params.inputStreams)) {
      workerInputStreams = params.inputStreams.map(({ stream, index }) => ({ stream, index }));
    }
    // Попробовать аккуратно вынуть остальные поля и "options"
    const { args, inputStreams, options: extraOptions, ...restParams } = params as any;
    optionsObj = { ...(typeof extraOptions === "object" ? extraOptions : {}), ...restParams };

    const worker = new Processor(optionsObj);
    if (workerArgs) worker.setArgs(workerArgs);
    if (workerInputStreams) worker.inputStreams = workerInputStreams;
    return worker;
  }
}

export default Processor;
