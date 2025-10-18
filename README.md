# Fluent Streamer

> 🇷🇺 [Читать на русском](/lang/ru/README.md)

**Fluent Streamer** is a powerful Node.js library for flexible audio and video stream management using FFmpeg. It supports extensible audio plugins (Gain, Bass, Treble, Compressor, and more) and a sleek Fluent API.

FluentStream is the primary API surface. You can register plugins globally and build end‑to‑end pipelines concisely.

Build real-time chains of any audio effects and instantly integrate them with PCM streams (Discord, WebRTC, FFmpeg, and more).

---

## Features

- Flexible registration and use of custom audio plugins
- Convenient Fluent API for building complex effect chains
- Individual parameters for each plugin
- Full compatibility with Node.js `stream.Transform`
- Real-time audio processing and native FFmpeg integration
- Rich event model: `start`, `spawn`, `progress`, `end`, `terminated`, `error`
- Support for async processing, extensibility, and type safety

---

## Installation

```bash
npm install fluent-streamer
# or
yarn add fluent-streamer
```

## Quick start (FluentStream as main API)

```ts
import FluentStream from "fluent-streamer";

// 1) Register plugins globally (once at startup)
FluentStream.registerPlugin("gain", (opts) => new GainPlugin(1.5));
FluentStream.registerPlugin("bass", () => new BassPlugin(0.6));

// 2) Build pipeline: file -> JS transforms -> encode -> stdout
const ff = new FluentStream({ suppressPrematureCloseWarning: true })
  .input("input.mp3")
  .usePlugins("gain", { name: "bass", options: { /* plugin-specific */ } })
  .audioCodec("aac")
  .outputOptions("-b:a", "192k")
  .output("pipe:1");

const { output, done } = ff.run();
output.pipe(process.stdout);
await done;
```

Stream input + FFmpeg filters (`-af`):

```ts
import { PassThrough } from "stream";

const input = new PassThrough();
const filters = ["volume=2", "bass=g=5"]; // standard FFmpeg audio filters

const ff = new FluentStream()
  .input(input)
  .inputOptions("-f", "mp3") // or your input format
  .output("pipe:1")
  .audioCodec("pcm_s16le")
  .outputOptions("-f", "s16le", "-ar", "48000", "-ac", "2", "-af", filters.join(","));

const { output, done } = ff.run();
// write bytes into `input` to stream into ffmpeg
```

Notes:
- Set `{ suppressPrematureCloseWarning: true }` if your consumer can close early and you want to silence benign "premature close" warnings.
- You can still use low‑level `Processor`, but FluentStream is preferred.

## Audio Plugins

Each plugin implements the `AudioPlugin` interface:

```ts
import { Transform } from "stream";
import { AudioPlugin, AudioPluginBaseOptions } from "fluent-streamer";

export class GainPlugin implements AudioPlugin {
  constructor(private gain: number) {}

  createTransform(options: Required<AudioPluginBaseOptions>): Transform {
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

## Plugin Registry (optional)

```ts
import { PluginRegistry } from "fluent-streamer";
import { GainPlugin, BassPlugin, TreblePlugin } from "./plugins";

const registry = new PluginRegistry();

// Register plugins with default settings
registry.register("gain", (opts) => new GainPlugin(opts.gain ?? 1));
registry.register("bass", (opts) => new BassPlugin(opts.bass ?? 0));
registry.register("treble", (opts) => new TreblePlugin(opts.treble ?? 0));
```

## Creating Plugin Chains (optional)

```ts
// Simple pipeline chain
registry.chain("gain", "bass", "treble")
  .pipeTo(destination);

// With individual parameters for each plugin
registry.chain(
  { name: "gain", options: { gain: 2 } },
  { name: "bass", options: { bass: 0.7 } },
  "treble"
).pipeTo(destination);

// Get a Transform chain for pipeline usage
const chainTransform = registry.chain("gain", "bass").getTransform();
ffmpegOutput.pipe(chainTransform).pipe(destination);
```

## Audio Stream Diagram

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

## FluentStream: High-Level API

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

- `.usePlugins(...configs)` / `.usePlugin(name, options?)` — attach globally registered plugins by name.
- `.withAudioPlugins(registry, ...configs)` — same as above but with custom registry.
- `.withAudioPlugin(plugin, buildEncoder, options?)` — attach a manually created plugin instance.
- `.crossfadeAudio(duration, options?)` — performs a crossfade between two audio inputs.

### Global plugin registry API

```ts
FluentStream.registerPlugin(name, factory);
FluentStream.hasPlugin(name) // boolean
FluentStream.clearPlugins()  // tests/tools only
```

## Processor — Low-level FFmpeg Execution (optional)

```ts
import { Processor } from "fluent-streamer";

const proc = new Processor({ suppressPrematureCloseWarning: true });
proc.setArgs(["-i", "input.mp3", "-f", "s16le", "pipe:1"]);
proc.run();
proc.on("progress", console.log);
proc.on("end", () => console.log("Done"));
```

## Dynamic Plugin Loading

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

## Events

- `start(cmd: string)` — before FFmpeg starts  
- `spawn(data)` — FFmpeg process started  
- `progress(progress: FFmpegProgress)` — progress via special side-channel  
- `end()` — process finished successfully  
- `terminated(signal: string)` — finished by signal  
- `error(err: Error)` — any error from process or streams  

---

## License

MIT