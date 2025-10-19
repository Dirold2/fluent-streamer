# Fluent Streamer

[Перейти на русскую версию](./lang/ru/README.md)

_Fluent_ FFmpeg wrapper for Node.js, written in TypeScript.  
Offers a fluent, chainable API for media/audio/video processing with FFmpeg, supporting streams, crossfade, plugin chains, timeouts, and progress tracking.

- **TypeScript-first**: typed, chainable, and modern
- **Streaming**: easy integration with Node streams
- **Extendable**: plugin system for custom audio effects
- **Human-friendly**: good defaults and self-describing API
- **Advanced features**: crossfade, format conversion, codec control, kill/timeout, progress

> Powered by [FFmpeg](https://ffmpeg.org/).  
> Works in Node.js and supports streaming (no file required).

---

## Installation

```
npm install fluent-streamer
```

---

## Usage

```ts
import FluentStream from "fluent-streamer";

// Basic conversion example
const fs = new FluentStream()
  .input("input.wav")
  .audioCodec("aac")
  .audioBitrate("192k")
  .output("output.m4a");

const { done } = fs.run();
done.then(() => console.log("Conversion finished."));
```

---

### Stream Processing

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
  console.log("Done streaming!");
});
```

---

### Crossfade Example

```ts
const streamer = new FluentStream();
streamer
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // 2.5 seconds crossfade
  .output("x.mp3")
  .run();
```

---

### Plugin System

```ts
FluentStream.registerPlugin("gain", (opts) => new GainPlugin(opts));

const f = new FluentStream()
  .input("a.wav")
  .usePlugins(myEncoderBuilder, { name: "gain", value: 5.2 })
  .output("louder.wav")
  .run();
```

---

## API Highlights

`FluentStream` provides a _fluent_ interface:

```ts
new FluentStream()
  .input("song.mp3")
  .seekInput(30)          // seek to 30s
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();
```

Main methods:
- `.input(src)` — add file/stream input
- `.output(dst)` — set the output (file/stream/fd)
- `.audioCodec(codec)` / `.videoCodec(codec)` — set codecs
- `.audioBitrate(bps)` / `.videoBitrate(bps)`
- `.format(fmt)` — set output format (e.g. 'mp3', 'wav')
- `.seekInput(time)` — seek input position
- `.overwrite()` — overwrite output file(s)
- `.map(spec)` — select specific streams
- `.crossfadeAudio(seconds, options?)` — crossfade (audio)
- `.usePlugins(builder, ...plugins)` — use a plugin chain on PCM (optional)
- `.run()` — start processing (returns output, done, stop)

---

## Advanced

- **Timeout:** Set the `timeout` option to auto-kill long FFmpeg jobs.
- **Progress:** Get real-time progress events by enabling `.options({ enableProgressTracking: true })` and listening for `"progress"` events.
- **Headers:** Default humanity headers are sent to FFmpeg HTTP(S) sources; override with `.setHeaders(obj)`.
- **Kill:** `run()` returns a stop function to terminate process safely.

---

## Types & Extensibility

- Written in TypeScript: all primary objects (FluentStream, Processor, Plugins) are strongly typed.
- Plugins: implement audio transforms, register with `FluentStream.registerPlugin`.

---

## License

MIT © dirold2

---
