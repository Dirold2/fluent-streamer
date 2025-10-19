# Fluent Streamer

[Switch to the English version](../../README.md)

_Fluent_ — обёртка для FFmpeg на Node.js, написанная на TypeScript.  
Предлагает современный, цепочный API для обработки медиа/аудио/видео через FFmpeg, поддерживает потоки, кроссфейд, цепочки плагинов, таймауты и отслеживание прогресса.

- **TypeScript-first**: типизированный, цепочный и современный API
- **Потоковая обработка**: простая интеграция с потоками Node.js
- **Расширяемость**: система плагинов для собственных аудио-эффектов
- **Дружелюбность**: хорошие значения по умолчанию и понятный API
- **Доп. функции**: кроссфейд, конвертация форматов, управление кодеками, авто-остановка/таймаут, отслеживание прогресса

> Работает на базе [FFmpeg](https://ffmpeg.org/).  
> Работает в Node.js и поддерживает потоковую обработку (без необходимости файлов).

---

## Установка

```
npm install fluent-streamer
```

---

## Пример использования

```ts
import FluentStream from "fluent-streamer";

// Пример конвертации
const fs = new FluentStream()
  .input("input.wav")
  .audioCodec("aac")
  .audioBitrate("192k")
  .output("output.m4a");

const { done } = fs.run();
done.then(() => console.log("Конвертация завершена."));
```

---

### Работа с потоками

```ts
import FluentStream from "fluent-streamer";
import fs from "node:fs";

const input = fs.createReadStream("track.mp3");
const output = fs.createWriteStream("new.wav");

const f = new FluentStream()
  .input(input)
  .format("wav")
  .output(output);

f.run().done.then(() => {
  console.log("Поток завершён!");
});
```

---

### Пример кроссфейда

```ts
const streamer = new FluentStream();
streamer
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // Кроссфейд 2.5 секунды
  .output("x.mp3")
  .run();
```

---

### Система плагинов

```ts
FluentStream.registerPlugin("gain", (opts) => new GainPlugin(opts));

const f = new FluentStream()
  .input("a.wav")
  .usePlugins(myEncoderBuilder, { name: "gain", value: 5.2 })
  .output("louder.wav")
  .run();
```

---

## Основные возможности API

`FluentStream` предоставляет _флюентный_ интерфейс:

```ts
new FluentStream()
  .input("song.mp3")
  .seekInput(30)          // перейти к 30 секунде
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();
```

Главные методы:
- `.input(src)` — добавить входной файл/поток
- `.output(dst)` — задать выход (файл/поток/дескриптор)
- `.audioCodec(codec)` / `.videoCodec(codec)` — выбрать кодеки
- `.audioBitrate(bps)` / `.videoBitrate(bps)` — битрейт аудио/видео
- `.format(fmt)` — задать формат выхода (например, 'mp3', 'wav')
- `.seekInput(time)` — начать чтение входа с позиции (сек)
- `.overwrite()` — перезаписать файлы назначения
- `.map(spec)` — выбрать определённые потоки
- `.crossfadeAudio(seconds, options?)` — кроссфейд для аудио
- `.usePlugins(builder, ...plugins)` — применить цепочку плагинов к PCM (опционально)
- `.run()` — запускает обработку (возвращает output, done, stop)

---

## Дополнительно

- **Таймаут:** опция `timeout` завершает долгие FFmpeg-процессы автоматически.
- **Прогресс:** события о ходе работы — включите `.options({ enableProgressTracking: true })` и слушайте `"progress"`.
- **Заголовки:** по умолчанию отправляются headers для HTTP(S) источников, можно настроить через `.setHeaders(obj)`.
- **Остановка:** `run()` возвращает функцию остановки процесса.

---

## Типизация и расширение

- Написано на TypeScript: все основные классы (FluentStream, Processor, Plugins) строго типизированы.
- Плагины: реализуйте свои аудио-преобразования, регистрируйте через `FluentStream.registerPlugin`.

---

## Лицензия

MIT © dirold2

---
