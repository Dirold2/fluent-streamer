# Fluent Streamer

> 🇬🇧 [Read in English](/README.md)

**Fluent Streamer** — мощная библиотека на Node.js для гибкого управления аудио и видео-потоками с помощью FFmpeg, с поддержкой расширяемых аудио-плагинов (Gain, Bass, Treble, Compressor и др.) и элегантного Fluent API.

Позволяет в реальном времени строить цепочки любых аудио-эффектов и мгновенно интегрировать их с PCM-потоками (Discord, WebRTC, FFmpeg и прочее).

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

## Аудио-плагины

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

## Реестр Плагинов (PluginRegistry)

```ts
import PluginRegistry from "fluent-streamer";
import { GainPlugin, BassPlugin, TreblePlugin } from "./plugins";

const registry = new PluginRegistry();

// Регистрация плагинов с настройками по умолчанию
registry.register("gain", (opts) => new GainPlugin(opts.gain ?? 1));
registry.register("bass", (opts) => new BassPlugin(opts.bass ?? 0));
registry.register("treble", (opts) => new TreblePlugin(opts.treble ?? 0));
```

## Создание цепочек плагинов

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
  .withAudioPlugin(
    registry.create("gain", { sampleRate: 48000, channels: 2 }),
    (encoder) => encoder.audioCodec("libopus")
  );

const { output, done } = ff.run();
output.pipe(destination);
await done;
```

- `.withAudioPlugin(plugin, buildEncoder, options?)` — подключает AudioPlugin к PCM потоку.
- `.crossfadeAudio(duration, options?)` — реализует кроссфейд между двумя аудио-входами.

## Processor — Низкоуровневый запуск FFmpeg

```ts
import { Processor } from "fluent-streamer";

const proc = new Processor();
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