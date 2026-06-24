# Fluent Streamer

[Switch to the English version](../../README.md)

_Fluent_ — обёртка для FFmpeg на TypeScript, **v0.5.0**.  
Предлагает современный, цепочный API для обработки медиа/аудио/видео через FFmpeg, поддерживает потоки, кроссфейд, аудио-эффекты, таймауты и отслеживание прогресса.

- **TypeScript-first**: типизированный, цепочный и современный API
- **Кросс-рантайм**: Node.js, Bun, Deno и Browser (через `@ffmpeg/ffmpeg`)
- **Web Streams**: нативные `ReadableStream`/`WritableStream`, совместимость с потоками Node.js
- **Аудио-обработка**: встроенные EQ, volume, compression эффекты
- **Дружелюбность**: хорошие значения по умолчанию и понятный API
- **Доп. функции**: кроссфейд, конвертация форматов, управление кодеками, авто-остановка/таймаут, отслеживание прогресса

> Работает на базе [FFmpeg](https://ffmpeg.org/).  
> Поддерживает Node.js, Bun, Deno и браузер. Потоковая обработка не требует файлов на диске.

---

## Установка

```bash
# Из npm (после публикации)
npm install fluent-streamer

# Из GitHub (последняя версия)
npm install github:dirold2/fluent-streamer

# Используя Yarn
yarn add github:dirold2/fluent-streamer

# Используя PNPM
pnpm install github:dirold2/fluent-streamer

# Используя Bun
bun install github:dirold2/fluent-streamer
```

**Браузер (опционально):** установите WASM-биндинги FFmpeg:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/core
```

---

## Пример использования

```ts
import { FluentStream } from "fluent-streamer";

// Пример конвертации
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

### Работа с потоками

```ts
import { FluentStream } from "fluent-streamer";
import fs from "node:fs";

const input = fs.createReadStream("track.mp3");

const f = new FluentStream()
  .input(input)
  .format("wav")
  .output("new.wav");

await f.run();
console.log("Поток завершён!");
```

---

### Пример кроссфейда

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5) // Кроссфейд 2.5 секунды
  .output("x.mp3")
  .run();
```

### Аудио-эффекты и управление

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
})
  .input("music.mp3")
  .setVolume(1.5)
  .setBass(8)
  .setTreble(-3)
  .setCompressor(true)
  .output("enhanced.wav");

const { done } = await streamer.run();
await done;
```

---

## Основные возможности API

`FluentStream` предоставляет _флюентный_ интерфейс:

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("song.mp3")
  .seekInput(30)
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();
```

Главные методы:
- `.input(src)` — добавить входной файл/URL/поток
- `.output(dst)` — задать выход (путь к файлу или pipe)
- `.audioCodec(codec)` / `.videoCodec(codec)` — выбрать кодеки
- `.audioBitrate(bps)` / `.videoBitrate(bps)` — битрейт аудио/видео
- `.format(fmt)` — задать формат выхода (например, 'mp3', 'wav')
- `.seekInput(time)` — начать чтение входа с позиции (сек)
- `.overwrite()` — перезаписать файлы назначения
- `.map(spec)` — выбрать определённые потоки
- `.crossfadeAudio(seconds, options?)` — кроссфейд для аудио
- `.run()` — запускает обработку асинхронно (возвращает `output`, `done`, `stop`)

---

## Дополнительно

- **Таймаут:** опция `timeout` завершает долгие FFmpeg-процессы автоматически.
- **Прогресс:** события о ходе работы — включите `.options({ enableProgressTracking: true })` и слушайте `"progress"`.
- **Заголовки:** по умолчанию отправляются headers для HTTP(S) источников, можно настроить через `.setHeaders(obj)`.
- **Остановка:** `run()` возвращает функцию остановки процесса.

---

## Типизация и расширение

- **Написано на TypeScript:** `FluentStream`, `Processor` и типы строго типизированы
- **Модульная архитектура:** `Fluent/`, `Core/`, `Runner/`, `Audio/`, `Types/`
- **Встроенная аудио-обработка:** Volume, EQ, compression через `AudioProcessor`
- **Расширяемые раннеры:** реализуйте `FFmpegRunner` для кастомного запуска FFmpeg

---

## Лицензия

MIT © dirold2

---
