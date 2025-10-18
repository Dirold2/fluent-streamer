# Fluent Streamer

> 🇷🇺 [Read in Russian](/lang/ru/README.md)

**Fluent Streamer** is a powerful Node.js library for advanced audio and video streaming, based on FFmpeg. It features a modern, flexible, fluent API and makes building extensible audio plugin chains easy. With *FluentStream*, you can concatenate, process, and transcode media streams using both native FFmpeg filters and JS-based plugins in real time.

FluentStream is the main API. Plugins are registered globally and complete pipelines can be built using concise chaining.

Create real-time audio effect chains and seamlessly connect with PCM streams for Discord, WebRTC, OBS, and any FFmpeg-based workflows.

---

## Features

- Register and use custom audio plugins with flexible options
- Compose complex transcoding pipelines with a fluent API
- Pass options to individual plugins in the chain
- Compatible with Node.js `stream.Transform` and pipeline flows
- Native FFmpeg integration for high performance
- Real-time, low-latency PCM processing
- Full event system: `start`, `spawn`, `progress`, `end`, `terminated`, `error`
- Dynamic plugin updating (hot-swap) at runtime
- TypeScript-first, extensible, async/sync API
- **Automatic “Humanity” HTTP headers** for all spawned FFmpeg processes (see below)

---

## Installation

```bash
npm install fluent-streamer
# or
yarn add fluent-streamer
```

---

## Quick Start

```ts
import FluentStream from "fluent-streamer";

// 1) Register your audio plugins globally
FluentStream.registerPlugin("gain", opts => new GainPlugin(opts.gain ?? 1));
FluentStream.registerPlugin("bass", opts => new BassPlugin(opts.bass ?? 0.6));

// 2) Build a pipeline: file -> plugins -> encode -> stdout
const ff = new FluentStream({ suppressPrematureCloseWarning: true })
  .input("input.mp3")
  .usePlugins(
    { name: "gain", options: { gain: 1.5 } },
    "bass"
  )
  .audioCodec("aac")
  .outputOptions("-b:a", "192k")
  .output("pipe:1");

// New methods from FluentStream.ts
ff.format("mp3");                             // Set output format, removes previous -f
ff.copyCodecs();                              // Add -c copy if needed
ff.overwrite();                               // Add -y to allow overwrite
ff.map("0:a:0");                              // Map input streams
ff.seekInput(12);                             // Seek input before -i
ff.complexFilter("[0:a]loudnorm[aout]");      // Add filter_complex
ff.crossfadeAudio(2.5, {
    inputA: "[0:a]", inputB: "[1:a]", outputLabel: "[xfade]"
});                                           // Add audio crossfade

const controllers = ff.getControllers();      // Get current plugin controllers
// Hot-swap (update) plugin chain after .usePlugins
await ff.updatePlugins({ name: "compressor", options: { threshold: -20 } });

const { output, done } = ff.run();
output.pipe(process.stdout);
await done;
```

---

## HTTP “Humanity” Headers

Every FFmpeg process spawned by FluentStream and Processor
will include special “humanity” headers to indicate friendly bot intent and user agent:

```json
{
  "X-Human-Intent": "true",
  "X-Request-Attention": "just-want-to-do-my-best",
  "User-Agent": "FluentStream/1.0 (friendly bot)"
}
```
You do not need to do anything — these headers are set automatically for each process invocation.

---

**Streaming input and using FFmpeg-native filters:**

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
// Write audio data into `input` to stream to ffmpeg
```

**Notes:**

- Use `{ suppressPrematureCloseWarning: true }` if you expect the consumer to terminate the stream early.
- You can always access the low-level `Processor` API if needed.

---

## Audio Plugins

All audio plugins must implement the `AudioPlugin` interface:

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

## Plugin Registry (optional/custom usage)

```ts
import { PluginRegistry } from "fluent-streamer";
import { GainPlugin, BassPlugin, TreblePlugin } from "./plugins";

const registry = new PluginRegistry();
registry.register("gain", opts => new GainPlugin(opts.gain ?? 1));
registry.register("bass", opts => new BassPlugin(opts.bass ?? 0));
registry.register("treble", opts => new TreblePlugin(opts.treble ?? 0));
```

---

## Building Plugin Chains

```ts
// Simple chain
registry.chain("gain", "bass", "treble")
  .pipeTo(destination);

// Per-plugin options
registry.chain(
  { name: "gain", options: { gain: 2 } },
  { name: "bass", options: { bass: 0.7 } },
  "treble"
).pipeTo(destination);

// Manual transform chain use
const chainTransform = registry.chain("gain", "bass").getTransform();
ffmpegOutput.pipe(chainTransform).pipe(destination);
```

---

## PCM Audio Plugin Pipeline Diagram

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

## FluentStream: High-Level API

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

### Main methods

- `.input(input: string | Readable)` — Add input file or stream
- `.usePlugins(...configs)` — Insert plugins (by name or with options) from the registry into the audio pipeline
- `.getControllers()` — Get active plugin controller instances
- `.updatePlugins(...)` — Hot-swap the plugin chain at runtime
- `.crossfadeAudio(duration, options?)` — Crossfade between two audio streams
- `.audioCodec(codec)`, `.output(path)`, `.outputOptions(...)`, `.inputOptions(...)`, `.seekInput(time)`, `.map(label)`
- `.complexFilter(string|string[])` — Append to FFmpeg filter_complex
- `.copyCodecs()`, `.format(fmt)`, `.overwrite()`
- `.run()` — Start pipeline; returns `{ output, done, stop }`
- `.getArgs()` — Current FFmpeg argument array

### Global plugin registry

```ts
FluentStream.registerPlugin(name, factory);
FluentStream.hasPlugin(name);      // Returns boolean
FluentStream.clearPlugins();       // Remove all plugins (e.g., for tests/dev)
```

---

## Low-level Processor API

```ts
import { Processor } from "fluent-streamer";

const proc = new Processor({ suppressPrematureCloseWarning: true });
proc.setArgs(["-i", "input.mp3", "-f", "s16le", "pipe:1"]);
proc.run();
proc.on("progress", console.log);
proc.on("end", () => console.log("Done"));
```

---

## Dynamic Plugin Loading Example

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

## Events

- `start(cmd)` — Before the FFmpeg process spawns
- `spawn(data)` — FFmpeg process started
- `progress(progress)` — Progress info from FFmpeg
- `end()` — Finished successfully
- `terminated(signal)` — Process was killed or interrupted
- `error(err)` — Error during processing or plugin operation

---

## License

MIT