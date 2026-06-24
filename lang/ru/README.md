# Fluent Streamer

[English Version](https://github.com/Dirold2/fluent-streamer)

_Fluent_ FFmpeg обёртка для TypeScript-рантаймов, **v0.5.1**
Предоставляет удобный цепочечный (fluent) API для обработки медиа, аудио и видео с помощью FFmpeg.
Поддерживает работу со стримами, кроссфейды, аудиоэффекты, таймауты и отслеживание прогресса.

- **TypeScript-first**: строго типизированный, современный цепочечный API
- **Кросс-рантаймность**: поддержка Node.js, Bun, Deno и Browser (через `@ffmpeg/ffmpeg`)
- **Web Streams**: нативные `ReadableStream`/`WritableStream` с обратной совместимостью со стримами Node.js
- **Обработка аудио**: встроенный эквалайзер (EQ), управление громкостью и динамической компрессией
- **Удобство использования**: оптимальные дефолтные настройки и самодокументируемый API
- **Продвинутые фичи**: кроссфейды, конвертация форматов, управление кодеками, принудительная остановка/таймауты, логирование прогресса

> Работает на базе [FFmpeg](https://ffmpeg.org/).  
> Поддерживается в Node.js, Bun, Deno и браузере. Потоковая обработка не требует сохранения временных файлов на диск.

---

## Установка

```bash
# Из npm (после публикации)
npm install fluent-streamer

# С GitHub (актуальная версия)
npm install github:dirold2/fluent-streamer

# Использование Yarn
yarn add github:dirold2/fluent-streamer

# Использование PNPM
pnpm install github:dirold2/fluent-streamer

# Использование Bun
bun install github:dirold2/fluent-streamer

```

**Браузер (опционально):** установите WASM-привязки FFmpeg вместе с основным пакетом:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/core

```

Браузерный раннер выбирается автоматически, если в глобальном контексте определен объект `window`.

### Миграция с версии 0.4.x

| 0.4.x | 0.5.x |
| --- | --- |
| `import FluentStream from "fluent-streamer"` | `import { FluentStream } from "fluent-streamer"` |
| `const { done } = fs.run()` | `const { done } = await fs.run()` |
| `output: Readable` (Node.js stream) | `output: ReadableStream<Uint8Array>` (Web Stream) |
| `.output(fs.createWriteStream(...))` | `.output("file.wav")` или чтение `output` из `.run()` |

---

## Использование

```ts
import { FluentStream } from "fluent-streamer";

// Простой пример конвертации файла
const fs = new FluentStream()
  .input("input.wav")
  .audioCodec("aac")
  .audioBitrate("192k")
  .output("output.m4a");

const { done } = await fs.run();
await done;
console.log("Конвертация завершена.");

```

---

### Потоковая обработка (Stream Processing)

```ts
import { FluentStream } from "fluent-streamer";
import fs from "node:fs";

// Стримы Node.js принимаются на вход (внутри адаптируются к Web Streams)
const input = fs.createReadStream("track.mp3");

const f = new FluentStream()
  .input(input)
  .format("wav")
  .output("new.wav");

await f.run();
console.log("Поток успешно обработан!");

```

Для перенаправления вывода в пайп используйте `pipe:1` и читайте возвращаемый стрим:

```ts
const { output, done } = await new FluentStream()
  .input(input)
  .format("wav")
  .output("pipe:1")
  .run();

// Направляем Web Stream в целевой поток (Node.js 18+)
import { Writable } from "node:stream";
const file = fs.createWriteStream("new.wav");
await output.pipeTo(Writable.toWeb(file));
await done;

```

---

### Пример создания кроссфейда

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // Кроссфейд длительностью 2.5 секунды
  .output("x.mp3")
  .run();

```

### Продвинутый пример стриминга

```ts
import { FluentStream } from "fluent-streamer";
import { Readable } from "node:stream";

// Стриминг из HTTP-источника в HTTP-ответ (например, в Express)
app.get("/audio/:fileId", async (req, res) => {
  const audioUrl = `https://cdn.example.com/audio/${req.params.fileId}.mp3`;

  try {
    const streamer = new FluentStream()
      .input(audioUrl)
      .setHeaders({
        Authorization: "Bearer token",
        "X-Client-Id": "my-app",
      })
      .audioCodec("aac")
      .audioBitrate("128k")
      .format("mp3")
      .output(FluentStream.stdout);

    const { output, done } = await streamer.run();

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'inline; filename="converted.mp3"');

    Readable.fromWeb(output).pipe(res);
    await done;
  } catch (error) {
    console.error("Ошибка стриминга аудио:", error);
    res.status(500).send("Streaming failed");
  }
});

```

### Аудиоэффекты в реальном времени

```ts
import { FluentStream } from "fluent-streamer";

// Создаем стример с поддержкой прогресса и аудиопроцессора
const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
});

const inputStream = getAudioSource(); // ReadableStream<Uint8Array> или Node.js Readable

const { output, done } = await streamer
  .input(inputStream)
  .audioCodec("pcm_s16le")
  .audioFrequency(44100)
  .audioChannels(2)
  .output("pipe:1")
  .run();

// Настройка аудиоэффектов "на лету" через свойства или change* методы
streamer.volume = 1.5;   // Увеличиваем громкость на 50%
streamer.bass = 5;       // Усиливаем басы
streamer.treble = -3;    // Снижаем высокие частоты

// Слушаем события прогресса
streamer.on("progress", (progress) => {
  console.log(`Прогресс обработки: ${progress.progress}%`);
});

await done;

```

### Плавное появление, затухание и переходы

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream()
  .input("background-music.mp3")
  .setVolume(0) // Начинаем с нулевой громкостью
  .output("fade-demo.mp3");

const { done } = await streamer.run();

// Плавное появление (Fade in) за 2 секунды
await new Promise((resolve) => setTimeout(resolve, 1000));
streamer.fadeIn(1, 2000); // Целевая громкость 1, время изменения 2000 мс

// Плавное затухание (Fade out) за 3 секунды перед окончанием
await new Promise((resolve) => setTimeout(resolve, 8000));
streamer.fadeOut(3000);

await done;

```

---

### Управление параметрами аудиопроцессора

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
})
  .input("music.mp3")
  .setVolume(1.5)      // Увеличение громкости на 50%
  .setBass(8)          // Буст басов
  .setTreble(-3)       // Небольшой срез высоких
  .setCompressor(true) // Включение динамического компрессора
  .output("enhanced.wav");

const { done } = await streamer.run();
await done;

```

---

## Обзор API

Класс `FluentStream` предоставляет удобный декларативный интерфейс:

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("song.mp3")
  .seekInput(30)          // перемотка на 30-ю секунду
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();

```

Основные методы:

* `.input(src)` — добавить входной файл/URL/стрим (`string`, `ReadableStream<Uint8Array>` или Node.js Readable).
* `.output(dst)` — задать назначение (путь к файлу, объект pipe или дескриптор).
* `.audioCodec(codec)` / `.videoCodec(codec)` — установить кодеки.
* `.audioBitrate(bps)` / `.videoBitrate(bps)` — установить битрейт.
* `.format(fmt)` — установить контейнер/формат вывода (например, 'mp3', 'wav').
* `.seekInput(time)` — начать чтение входного потока со смещением во времени.
* `.overwrite()` — разрешить перезапись выходных файлов.
* `.map(spec)` — выбор конкретных дорожек/потоков (FFmpeg stream mapping).
* `.crossfadeAudio(seconds, options?)` — применить фильтр плавного перехода аудио.
* `.run()` — запустить процесс асинхронно (возвращает объект со ссылкой на `output`, промис `done` и функцию `stop`).

---

## Справочник по API

### Конструктор

```ts
new FluentStream(options?: ProcessorOptions)

```

Создает новый экземпляр `FluentStream` с необязательными глобальными конфигурациями.

**Параметры (Options):**

* `timeout?: number` - таймаут процесса FFmpeg в секундах.
* `enableProgressTracking?: boolean` - включить генерацию событий прогресса.
* `failFast?: boolean` - немедленно останавливать обработку при первой ошибке.
* `wallTimeLimit?: number` - максимальный лимит астрономического времени работы.
* `useAudioProcessor?: boolean` - активировать встроенный аудиопроцессор для эффектов.
* `audioProcessorOptions?: AudioProcessingOptions` - дефолтные параметры эффектов (громкость, басы, высокие, компрессор, частота дискретизации, каналы).
* `logger?: Logger` - кастомный объект логгера (методы debug, info, warn, error).
* `verbose?: boolean` - включить подробный вывод отладочных логов.

### Методы Ввода/Вывода

#### `.input(source: string | ReadableStream<Uint8Array> | NodeJS.Readable, options?: InputOptions)`

Добавить файл, URL, blob URL или входящий стрим.

```ts
// Файловый ввод
.input('/path/to/audio.mp3')

// HTTP URL с кастомными заголовками
.input('[https://cdn.com/track.mp3](https://cdn.com/track.mp3)')

// Ввод через Web Stream
.input(readableStream)

// Ввод через Node.js stream
.input(fs.createReadStream('input.wav'), { pipeIndex: 0 })

```

**Опции ввода (InputOptions):**

* `label?: string` - идентификатор/метка входного источника.
* `pipeIndex?: number` - кастомный индекс пайпа для стримов.
* `allowDuplicate?: boolean` - разрешить добавление дублирующихся источников.

#### `.output(destination: string | number | PipeObject)`

Задать цель вывода.

```ts
// Запись в файл (автоматически перезаписывается при вызове .overwrite())
.output('/path/to/output.mp4')

// Вывод в stdout / пайп
.output(FluentStream.stdout)
.output({ pipe: 'pipe:1' })

```

При работе с потоками используйте `pipe:1` для последующего чтения стрима `output` из результатов выполнения `.run()`.

### Конфигурация Аудио и Видео

#### `.audioCodec(codec: string)`

Установить аудиокодек: `'aac'`, `'mp3'`, `'opus'`, `'vorbis'`, `'pcm_s16le'` и т.д.

#### `.videoCodec(codec: string)`

Установить видеокодек: `'h264'`, `'h265'`, `'vp9'`, `'av1'`, `'mpeg4'` и т.д.

#### `.audioBitrate(bitrate: string)`

Установить аудиобитрейт: `'128k'`, `'192k'`, `'320k'`, `'variable'` и т.д.

#### `.videoBitrate(bitrate: string)`

Установить видеобитрейт: `'1M'`, `'2M'`, `'5M'`, `'10M'` и т.д.

#### `.format(format: string)`

Установить формат медиаконтейнера: `'mp3'`, `'mp4'`, `'wav'`, `'flac'`, `'webm'` и т.д.

#### `.audioFrequency(frequency: number)`

Установить частоту дискретизации: `44100`, `48000`, `96000` и т.д.

#### `.audioChannels(channels: number)`

Установить количество аудиоканалов: `1` (моно), `2` (стерео), `6` (5.1), `8` (7.1).

### Управление процессом

#### `.seekInput(position: number | string)`

Смещение во входном потоке: `30`, `'00:00:30'`, `'1:30'` и т.д.

#### `.duration(time: number | string)`

Ограничить общую длительность выходного медиа.

#### `.map(spec: string)`

Выбрать определенные дорожки (FFmpeg stream mapping):

```ts
.map('0:v')  // Выбрать только видео из первого источника
.map('1:a')  // Выбрать только аудио из второго источника
.map('0')    // Выбрать все дорожки из первого источника

```

#### `.noVideo()`, `.noAudio()`

Полностью отключить обработку видео или аудио соответственно.

#### `.overwrite()`

Разрешить перезапись существующих файлов на диске.

#### `.copyCodecs()`

Копировать потоки без перекодирования (режим `copy` — увеличивает скорость и сохраняет исходное качество).

### Аудиоэффекты (с поддержкой реального времени)

#### `.setVolume(value: number)`

Установить множитель громкости (0-2): `0.5` (тише в два раза), `1.0` (норма), `1.5` (громче на 50%).

#### `.setBass(value: number)`

Настройка уровня баса (от -20 до 20 дБ): `0` (нейтрально), `5` (усиление), `-3` (срез).

#### `.setTreble(value: number)`

Настройка высоких частот (от -20 до 20 дБ): `0` (нейтрально), `5` (усиление), `-3` (срез).

#### `.setCompressor(enabled: boolean)`

Включить/выключить динамический компрессор для выравнивания уровня звука.

#### `.setEqualizer(bass, treble, compressor)`

Применить все параметры эквалайзера и компрессии одновременно.

#### `.fadeIn(targetVolume?: number, durationMs?: number)`

Плавное повышение громкости от текущего уровня до целевого.

#### `.fadeOut(durationMs?: number)`

Плавное затухание звука до полной тишины.

**Изменение параметров "на лету" (во время выполнения):**

* `.changeVolume(value: number)` — возвращает boolean (успешно ли применено)
* `.changeBass(value: number)` — возвращает boolean
* `.changeTreble(value: number)` — возвращает boolean
* `.changeCompressor(enabled: boolean)` — возвращает boolean
* `.changeEqualizer(bass, treble, compressor)` — возвращает boolean

### Продвинутые возможности

#### `.crossfadeAudio(duration: number, options?)`

Организовать плавное пересечение (кроссфейд) аудиодорожек с помощью встроенного фильтра `acrossfade`.

```ts
.crossfadeAudio(2.5, {
  curve1: 'tri',     // тип кривой затухания первого трека
  curve2: 'tri',     // тип кривой появления второго трека
  overlap: true,
  secondInput: 'path/to/second.mp3'
})

```

#### `.complexFilter(graph: string | string[])`

Добавить произвольные сложные графы фильтров FFmpeg (`-filter_complex`).

### Опции и Кастомизация Аргументов

#### `.setHeaders(headers: Record<string, string>)`

Передать кастомные HTTP-заголовки для сетевых источников запросов.

#### `.userAgent(userAgent: string)`

Установить кастомный User-Agent для HTTP-запросов.

#### `.globalOptions(...args)`, `.inputOptions(...args)`, `.outputOptions(...args)`

Добавление любых сырых аргументов FFmpeg в соответствующие позиции командной строки.

### Контроль Жизненного Цикла Жобы

#### `.run(options?) → Promise<FFmpegRunResultExtended>`

Запустить обработку. Возвращает объект:

```ts
{
  output: ReadableStream<Uint8Array>,  // Выходной стрим данных (при использовании pipe)
  done: Promise<void>,                 // Промис, разрешающийся при завершении или падающий при ошибке
  stop: () => void,                    // Функция для преднамеренной остановки (kill) процесса
  passthrough: ReadableStream<Uint8Array>,
  close: () => Promise<void> | void,
  setVolume?, setBass?, setTreble?, setCompressor?, setEqualizer?, startFade?
}

```

Промис `done` успешно завершается при штатном окончании работы FFmpeg или при вызове `stop()`/`close()`. Промис отклоняется (reject) в случае ошибок спавна процесса, таймаутов или возврата ненулевого кода ошибки от FFmpeg. В Node.js системные сбои (например, `spawn ffmpeg ENOENT`) обрабатываются явно и всплывают как ошибки процесса, а не маскируются под неопределенный код завершения.

#### `.clear()`

Сбросить состояние экземпляра для его повторного использования (обязательно вызывать перед повторным запуском `.run()`).

#### `.isDirtyState()`, `.isReady()`

Проверить текущее состояние готовности билдера.

#### События экземпляра (Events)

* `'progress'` — обновление прогресса (если `enableProgressTracking: true`).
* `'error'` — критическая ошибка обработки.
* `'complete'` — успешное окончание выполнения задачи.
* `'start'` — запуск процесса FFmpeg.

### Статические свойства

#### Статические пайпы для вывода

* `FluentStream.stdout` — подставляет `{ pipe: 'stdout' }`
* `FluentStream.stderr` — подставляет `{ pipe: 'stderr' }`
* `FluentStream.pipe1` — подставляет `{ pipe: 'pipe:1' }`
* `FluentStream.pipe2` — подставляет `{ pipe: 'pipe:2' }`

---

## Продвинутые Темы

* **Таймауты:** Свойство `timeout` автоматически уничтожает зависшие/долгие процессы FFmpeg; при этом промис `done` отклоняется с ошибкой таймаута.
* **Прогресс:** События `"progress"` парсят stderr FFmpeg в реальном времени и возвращают объект с процентами, текущим временем и скоростью кодирования.
* **Заголовки:** По умолчанию для удаленных HTTP-источников отправляются базовые маскировочные заголовки; их можно кастомизировать через `.setHeaders(obj)`.
* **Контроль завершения:** Методы `stop()` и `close()` изолированы от системных сбоев FFmpeg, позволяя безопасно завершать воспроизведение/обработку по логике приложения.

---

## Архитектура проекта

* **Strict TypeScript:** Полная типобезопасность ядра (`FluentStream`, `Processor`).
* **Модульная структура:** Код разделен на независимые слои: `Fluent/` (построение API), `Core/` (выполнение процессов), `Runner/` (адаптеры под платформы), `Audio/` (контроллеры эффектов).
* **Встроенная обработка аудио:** Классы `AudioProcessor` и `AudioEffectController` манипулируют бинарными PCM-данными "на лету" без привлечения тяжелых сторонних утилит.
* **Расширяемые раннеры:** Вы можете написать свой класс на базе интерфейса `FFmpegRunner` для интеграции со специфичными средами выполнения или кастомного распределения памяти.

---

## Устранение неполадок (Troubleshooting)

### Часто встречающиеся проблемы

**FFmpeg не найден:**

```
Error: spawn ffmpeg ENOENT

```

* Убедитесь, что FFmpeg установлен в системе и добавлен в переменные окружения PATH.
* В Linux/macOS проверьте путь через терминал: `which ffmpeg`.
* В Windows убедитесь, что путь к директории с `ffmpeg.exe` прописан в системных переменных.
* Решение без изменения PATH: Передайте точный путь при инициализации: `new FluentStream({ ffmpegPath: '/usr/bin/ffmpeg' })`.

**Ошибки сети при работе с HTTP-источниками:**

```
[tcp @ 0x...] Connection refused

```

* Проверьте доступность ссылки: `curl -I https://example.com/audio.mp3`.
* Убедитесь, что брандмауэр или настройки прокси не блокируют исходящие запросы FFmpeg.
* Некоторые серверы могут банить запросы без валидных браузерных заголовков (используйте методы `.userAgent()` и `.setHeaders()`).

**Кодек или формат не поддерживается:**

```
Unknown encoder 'xxx' or unsupported codec

```

* Проверьте сборку FFmpeg на поддержку нужного кодека: `ffmpeg -codecs | grep xxx`.
* Для некоторых кодеков требуются non-free сборки FFmpeg (например, для fdk-aac).
* В качестве альтернативы попробуйте использовать более распространенные кодеки (например, `aac` вместо редких форматов).

**Исчерпание оперативной памяти (Out of memory):**

```
Cannot allocate memory

```

* Снизьте разрешение или частоту кадров (FPS) для видеопотоков.
* Используйте метод `copyCodecs()` там, где перекодирование не требуется.
* Ограничивайте количество одновременно запущенных инстансов `FluentStream` для контроля лимитов памяти.

### Советы по отладке

**Включение детального логирования:**

```ts
const streamer = new FluentStream({
  logger: console, // Передаем нативный консольный логгер
  verbose: true,   // Активируем вывод подробных сообщений
});

```

**Инспекция сгенерированных аргументов:**

```ts
const streamer = new FluentStream()
  .input('in.mp3')
  .audioCodec('aac')
  .output('out.m4a');

console.log('Аргументы FFmpeg:', streamer.getArgs());
console.log('Сводка входов:', streamer.getInputSummary());

```

---

## Разработка и контрибьютинг

### Сборка проекта

```bash
git clone [https://github.com/Dirold2/fluent-streamer.git](https://github.com/Dirold2/fluent-streamer.git)
cd fluent-streamer
npm install
npm run build
npm test

```

### Стандарты кодирования

* **TypeScript:** Обязательна строгая типизация (`strict: true`), код должен успешно проходить проверки oxlint.
* **Именование:** CamelCase для классов и типов, camelCase для методов, функций и свойств объектов.
* **Документация:** Каждое публичное свойство и метод должны снабжаться JSDoc-комментариями.
* **Тесты:** Проект покрывается тестами на базе Vitest; целевой показатель покрытия — не менее 90%.

---

## Лицензия

MIT © dirold2
