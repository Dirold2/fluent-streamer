# Fluent Streamer

> 🇬🇧 [Read in English](/README.md)

**Fluent Streamer** — это мощная библиотека для Node.js для продвинутой работы с аудио- и видеостримингом на основе FFmpeg. Она предлагает современный, гибкий, лаконичный API (Fluent API) и упрощает сборку расширяемых цепочек аудио‑плагинов. С помощью *FluentStream* вы можете конкатенировать, обрабатывать и транскодировать медиа‑потоки с использованием нативных FFmpeg‑фильтров и JS‑плагинов в реальном времени.

Главный API — это FluentStream. Плагины регистрируются глобально, собирать сложные обработки можно лаконичной цепочкой вызовов.

Создавайте в реальном времени звуковые цепочки эффектов и легко интегрируйте их с PCM‑потоками для Discord, WebRTC, OBS и любых пайплайнов с FFmpeg.

---

## Особенности

- Регистрация и использование кастомных аудио‑плагинов с любыми параметрами
- Комбинирование сложных конвейеров преобразований через Fluent API
- Передача опций для каждого плагина в цепочке
- Поддержка Node.js `stream.Transform` и пайплайнов
- Нативная интеграция с FFmpeg для высокой производительности
- Обработка аудио в реальном времени и с малой задержкой
- Полная система событий: `start`, `spawn`, `progress`, `end`, `terminated`, `error`
- Горячая замена плагинов (hot-swap) без остановки FFmpeg
- API на TypeScript, расширяемый, синхронный и асинхронный
- **Автоматические HTTP‑заголовки “Humanity”** у всех создаваемых процессов FFmpeg (см. ниже)

---

## Установка

```bash
npm install fluent-streamer
# или
yarn add fluent-streamer
```

---

## Быстрый старт

```ts
import FluentStream from "fluent-streamer";

// 1) Зарегистрируйте ваши плагины глобально
FluentStream.registerPlugin("gain", opts => new GainPlugin(opts.gain ?? 1));
FluentStream.registerPlugin("bass", opts => new BassPlugin(opts.bass ?? 0.6));

// 2) Соберите конвейер: файл -> плагины -> кодек -> stdout
const ff = new FluentStream({ suppressPrematureCloseWarning: true })
  .input("input.mp3")
  .usePlugins(
    { name: "gain", options: { gain: 1.5 } },
    "bass"
  )
  .audioCodec("aac")
  .outputOptions("-b:a", "192k")
  .output("pipe:1");

// Новые методы из FluentStream.ts
ff.format("mp3");                             // Выбрать выходной формат / убрать прошлый -f
ff.copyCodecs();                              // Добавить -c copy если нужно
ff.overwrite();                               // Добавить -y (overwrite)
ff.map("0:a:0");                              // Указать входные дорожки
ff.seekInput(12);                             // Seek на входе, ДО -i
ff.complexFilter("[0:a]loudnorm[aout]");      // Добавить filter_complex
ff.crossfadeAudio(2.5, {
    inputA: "[0:a]", inputB: "[1:a]", outputLabel: "[xfade]"
});                                           // Аудио-кроссфейд

const controllers = ff.getControllers();      // Текущие контроллеры плагинов
// Горячая замена цепочки плагинов после .usePlugins
await ff.updatePlugins({ name: "compressor", options: { threshold: -20 } });

const { output, done } = ff.run();
output.pipe(process.stdout);
await done;
```

---

## HTTP “Humanity” заголовки

Каждый процесс FFmpeg, запущенный через FluentStream и Processor, будет содержать специальные “humanity” заголовки, чтобы отмечать дружественное намерение (бот, но хороший):

```json
{
  "X-Human-Intent": "true",
  "X-Request-Attention": "just-want-to-do-my-best",
  "User-Agent": "FluentStream/1.0 (friendly bot)"
}
```
Вам ничего не нужно настраивать — эти заголовки автоматически добавляются при каждом запуске.

---

**Пример с входным стримом и FFmpeg‑фильтрами:**

```ts
import { PassThrough } from "stream";

const input = new PassThrough();
const filters = ["volume=2", "bass=g=5"]; // FFmpeg filtergraph

const ff = new FluentStream()
  .input(input)
  .inputOptions("-f", "mp3")
  .output("pipe:1")
  .audioCodec("pcm_s16le")
  .outputOptions("-f", "s16le", "-ar", "48000", "-ac", "2", "-af", filters.join(","));

const { output, done } = ff.run();
// Пишите аудиоданные в `input`, чтобы стримить в ffmpeg
```

**Заметки:**
- Используйте `{ suppressPrematureCloseWarning: true }`, если конечный потребитель может завершаться раньше ожидаемого.
- Всегда можете пользоваться низкоуровневым API через `Processor`, но рекомендуемый (высокоуровневый) — это `FluentStream`.

---

## Аудио-плагины

Все аудио‑плагины реализуют интерфейс `AudioPlugin`:

```ts
import { Transform } from "stream";
import { AudioPlugin, AudioPluginBaseOptions } from "fluent-streamer";

export class GainPlugin implements AudioPlugin {
  constructor(private gain: number) {}

  createTransform(options: Required<AudioPluginBaseOptions>): Transform {
    const gain = this.gain;
    return new Transform({
      transform(chunk, _enc, cb) {
        const samples = new Int16Array(
          chunk.buffer, chunk.byteOffset, chunk.length / 2
        );
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.max(-32768, Math.min(32767, samples[i] * gain));
        }
        cb(null, chunk);
      },
    });
  }
}
```

---

## Реестр плагинов (опционально/кастомный usage)

```ts
import { PluginRegistry } from "fluent-streamer";
import { GainPlugin, BassPlugin, TreblePlugin } from "./plugins";

const registry = new PluginRegistry();
registry.register("gain", opts => new GainPlugin(opts.gain ?? 1));
registry.register("bass", opts => new BassPlugin(opts.bass ?? 0));
registry.register("treble", opts => new TreblePlugin(opts.treble ?? 0));
```

---

## Сборка цепочек плагинов

```ts
// Простая цепочка
registry.chain("gain", "bass", "treble")
  .pipeTo(destination);

// С индивидуальными параметрами для каждого плагина
registry.chain(
  { name: "gain", options: { gain: 2 } },
  { name: "bass", options: { bass: 0.7 } },
  "treble"
).pipeTo(destination);

// Ручное использование цепочки-трансформа:
const chainTransform = registry.chain("gain", "bass").getTransform();
ffmpegOutput.pipe(chainTransform).pipe(destination);
```

---

## Диаграмма обработки аудио-потока

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

---

## FluentStream: Высокоуровневый API

```ts
import FluentStream from "fluent-streamer";

const ff = new FluentStream()
  .input("input.mp3")
  .audioCodec("libopus")
  .format("opus")
  .output("pipe:1")
  .usePlugins("gain", "bass")
  .audioCodec("libopus")
  .copyCodecs()
  .overwrite()
  .seekInput("00:00:30")
  .map("0:a:0")
  .complexFilter("[0:a]loudnorm[aout]")
  .crossfadeAudio(2.5, { inputA: '[0:a]', inputB: '[1:a]', outputLabel: '[crossed]' });

const controllers = ff.getControllers();
await ff.updatePlugins("compressor", { name: "custom", options: { ratio: 2 } });

const { output, done } = ff.run();
output.pipe(destination);
await done;
```

### Основные методы

- `.input(input: string | Readable)` — добавить входной файл или поток
- `.usePlugins(...configs)` — подключить плагины (по имени или c опциями) из общего реестра
- `.getControllers()` — вернуть экземпляры контроллеров плагинов
- `.updatePlugins(...)` — hot-swap цепочки плагинов на лету
- `.crossfadeAudio(duration, options?)` — кроссфейд между двумя аудио‑входами
- `.audioCodec(codec)`, `.output(path)`, `.outputOptions(...)`, `.inputOptions(...)`, `.seekInput(time)`, `.map(label)`
- `.complexFilter(string|string[])` — добавить к FFmpeg filter_complex
- `.copyCodecs()`, `.format(fmt)`, `.overwrite()`
- `.run()` — запустить pipeline; возвращает объект `{ output, done, stop }`
- `.getArgs()` — текущий массив аргументов FFmpeg

### Глобальный реестр плагинов

```ts
FluentStream.registerPlugin(name, factory);
FluentStream.hasPlugin(name);      // возвращает boolean
FluentStream.clearPlugins();       // удалить все плагины (для тестов/разработки)
```

---

## Низкоуровневый Processor API

```ts
import { Processor } from "fluent-streamer";

const proc = new Processor({ suppressPrematureCloseWarning: true });
proc.setArgs(["-i", "input.mp3", "-f", "s16le", "pipe:1"]);
proc.run();
proc.on("progress", console.log);
proc.on("end", () => console.log("Done"));
```

---

## Пример динамической загрузки плагинов

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

---

## События

- `start(cmd)` — перед стартом FFmpeg процесса
- `spawn(data)` — процесс FFmpeg запущен
- `progress(progress)` — прогресс сгенерирован FFmpeg
- `end()` — завершено успешно
- `terminated(signal)` — завершено по сигналу/прерыванию
- `error(err)` — ошибка в процессе или плагине

---

## Лицензия

MIT