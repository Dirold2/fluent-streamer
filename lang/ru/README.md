# Fluent Streamer

> 🇬🇧 [Read in English](/README.md)

**Fluent Streamer** — мощная библиотека на Node.js для гибкого управления аудио и видео‑потоками с помощью FFmpeg, с поддержкой расширяемых аудио‑плагинов (Gain, Bass, Treble, Compressor и др.) и элегантного Fluent API.

Главная точка входа — `FluentStream`. Плагины можно регистрировать глобально и собирать конвейеры максимально кратко.

---

## Особенности

- Гибкая регистрация и использование пользовательских аудио-плагинов
- Удобное Fluent API для построения сложных эффект-цепочек
- Индивидуальные параметры для каждого плагина
- Полная совместимость с Node.js `stream.Transform`
- Работа с real-time аудио и нативная интеграция с FFmpeg
- Богатая событийная модель: `start`, `spawn`, `progress`, `end`, `terminated`, `error`
- Поддержка асинхронной обработки, расширяемость, типизация

---

## Установка

```bash
npm install fluent-streamer
# или
yarn add fluent-streamer
```

## Быстрый старт (FluentStream как основной API)

```ts
import FluentStream from "fluent-streamer";

// 1) Глобальная регистрация плагинов (один раз при старте)
FluentStream.registerPlugin("gain", (opts) => new GainPlugin(1.5));
FluentStream.registerPlugin("bass", () => new BassPlugin(0.6));

// 2) Конвейер: файл -> JS трансформы -> кодек -> stdout
const ff = new FluentStream({ suppressPrematureCloseWarning: true })
  .input("input.mp3")
  .usePlugins("gain", { name: "bass", options: { /* параметры плагина */ } })
  .audioCodec("aac")
  .outputOptions("-b:a", "192k")
  .output("pipe:1");

const { output, done } = ff.run();
output.pipe(process.stdout);
await done;
```

Входной стрим + FFmpeg‑фильтры (`-af`):

```ts
import { PassThrough } from "stream";

const input = new PassThrough();
const filters = ["volume=2", "bass=g=5"]; // стандартные аудио‑фильтры FFmpeg

const ff = new FluentStream()
  .input(input)
  .inputOptions("-f", "mp3") // или свой формат входа
  .output("pipe:1")
  .audioCodec("pcm_s16le")
  .outputOptions("-f", "s16le", "-ar", "48000", "-ac", "2", "-af", filters.join(","));

const { output, done } = ff.run();
// пишите байты в `input`, чтобы стримить в ffmpeg
```

Примечания:
- `{ suppressPrematureCloseWarning: true }` — подавляет безвредные предупреждения о «premature close», если потребитель может закрываться раньше.
- Низкоуровневый `Processor` остаётся доступен, но предпочтителен `FluentStream`.

## Аудио‑плагины

Каждый плагин реализует интерфейс `AudioPlugin`:

```ts
import { Transform } from "stream";
import { AudioPlugin, AudioPluginOptions } from "fluent-streamer";

export class GainPlugin implements AudioPlugin {
  constructor(private gain: number) {}

  createTransform(options: Required<AudioPluginOptions>): Transform {
    return new Transform({
      transform(chunk, _enc, cb) {
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, samples[i] * this.gain));
        }
        cb(null, chunk);
      },
    }) as Transform;
  }
}
```

## Реестр плагинов (опционально)

```ts
import PluginRegistry from "fluent-streamer";
import { GainPlugin, BassPlugin, TreblePlugin } from "./plugins";

const registry = new PluginRegistry();

// Регистрация плагинов с настройками по умолчанию
registry.register("gain", (opts) => new GainPlugin(opts.gain ?? 1));
registry.register("bass", (opts) => new BassPlugin(opts.bass ?? 0));
registry.register("treble", (opts) => new TreblePlugin(opts.treble ?? 0));
```

## Создание цепочек плагинов (опционально)

```ts
// Простая конвейерная цепочка
registry.chain("gain", "bass", "treble")
  .pipeTo(destination);

// С индивидуальными параметрами для каждого плагина
registry.chain(
  { name: "gain", options: { gain: 2 } },
  { name: "bass", options: { bass: 0.7 } },
  "treble"
).pipeTo(destination);

// Получение Transform цепочки для использования в pipeline
const chainTransform = registry.chain("gain", "bass").getTransform();
ffmpegOutput.pipe(chainTransform).pipe(destination);
```

## Диаграмма аудиопотока

```plaintext
Input Stream (FFmpeg / PCM)
        │
        ▼
    [GainPlugin]
        │
        ▼
    [BassPlugin]
        │
        ▼
   [TreblePlugin]
        │
        ▼
 [CompressorPlugin]
        │
        ▼
     Output Stream
 (Discord PCM / FFmpeg pipe)
```

## FluentStream: Высокоуровневый API

```ts
import FluentStream from "fluent-streamer";

const ff = new FluentStream()
  .input("input.mp3")
  .audioCodec("libopus")
  .format("opus")
  .output("pipe:1")
  .usePlugins("gain")
  .audioCodec("libopus");

const { output, done } = ff.run();
output.pipe(destination);
await done;
```

- `.usePlugins(...configs)` / `.usePlugin(name, options?)` — подключение глобально зарегистрированных плагинов по имени.
- `.withAudioPlugins(registry, ...configs)` — то же самое, но с кастомным реестром.
- `.withAudioPlugin(plugin, buildEncoder, options?)` — подключение вручную созданного экземпляра плагина.
- `.crossfadeAudio(duration, options?)` — реализует кроссфейд между двумя аудио-входами.

### Глобальный реестр плагинов

```ts
FluentStream.registerPlugin(name, factory);
FluentStream.hasPlugin(name) // boolean
FluentStream.clearPlugins()  // только для тестов/утилит
```

## Processor — низкоуровневый запуск FFmpeg (опционально)

```ts
import { Processor } from "fluent-streamer";

const proc = new Processor({ suppressPrematureCloseWarning: true });
proc.setArgs(["-i", "input.mp3", "-f", "s16le", "pipe:1"]);
proc.run();
proc.on("progress", console.log);
proc.on("end", () => console.log("Done"));
```

## Динамическая загрузка плагинов

```ts
import fs from "fs";
import path from "path";

const pluginsPath = path.resolve(__dirname, "plugins");
for (const file of fs.readdirSync(pluginsPath)) {
  const pluginModule = await import(path.join(pluginsPath, file));
  const pluginClass = pluginModule.default ?? Object.values(pluginModule)[0];
  registry.register(file.replace(/\.(ts|js)$/, ""), (opts) => new pluginClass(opts));
}
```

## События

- `start(cmd: string)` — перед стартом FFmpeg  
- `spawn(data)` — процесс FFmpeg запущен  
- `progress(progress: FFmpegProgress)` — прогресс через специальный канал  
- `end()` — процесс завершился успешно  
- `terminated(signal: string)` — завершено по сигналу  
- `error(err: Error)` — любая ошибка процесса или потока  

---

## License

MIT