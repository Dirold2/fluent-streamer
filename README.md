# Fluent Streamer

[Перейти на русскую версию](https://github.com/Dirold2/fluent-streamer/tree/main/lang/ru)

_Fluent_ FFmpeg wrapper for TypeScript runtimes, **v0.5.1**  
Offers a fluent, chainable API for media/audio/video processing with FFmpeg, supporting streams, crossfade, audio effects, timeouts, and progress tracking.

- **TypeScript-first**: typed, chainable, and modern
- **Cross-runtime**: Node.js, Bun, Deno, and Browser (via `@ffmpeg/ffmpeg`)
- **Web Streams**: native `ReadableStream`/`WritableStream` with Node.js stream compatibility
- **Audio processing**: built-in EQ, volume, compression controls
- **Human-friendly**: good defaults and self-describing API
- **Advanced features**: crossfade, format conversion, codec control, kill/timeout, progress

> Powered by [FFmpeg](https://ffmpeg.org/).  
> Works in Node.js, Bun, Deno, and the browser. Streaming does not require files on disk.

---

## Installation

```bash
# From npm (when published)
npm install fluent-streamer

# From GitHub (latest)
npm install github:dirold2/fluent-streamer

# Using Yarn
yarn add github:dirold2/fluent-streamer

# Using PNPM
pnpm install github:dirold2/fluent-streamer

# Using Bun
bun install github:dirold2/fluent-streamer
```

**Browser (optional):** install FFmpeg WASM bindings alongside the package:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/core
```

The browser runner is selected automatically when `window` is defined.

### Migrating from 0.4.x

| 0.4.x | 0.5.x |
|-------|-------|
| `import FluentStream from "fluent-streamer"` | `import { FluentStream } from "fluent-streamer"` |
| `const { done } = fs.run()` | `const { done } = await fs.run()` |
| `output: Readable` (Node.js) | `output: ReadableStream<Uint8Array>` |
| `.output(fs.createWriteStream(...))` | `.output("file.wav")` or pipe `output` from `.run()` |

---

## Usage

```ts
import { FluentStream } from "fluent-streamer";

// Basic conversion example
const fs = new FluentStream()
  .input("input.wav")
  .audioCodec("aac")
  .audioBitrate("192k")
  .output("output.m4a");

const { done } = await fs.run();
await done;
console.log("Conversion finished.");
```

---

### Stream Processing

```ts
import { FluentStream } from "fluent-streamer";
import fs from "node:fs";

// Node.js streams are accepted as input (adapted to Web Streams internally)
const input = fs.createReadStream("track.mp3");

const f = new FluentStream()
  .input(input)
  .format("wav")
  .output("new.wav");

await f.run();
console.log("Done streaming!");
```

For piped output, use `pipe:1` and consume the returned stream:

```ts
const { output, done } = await new FluentStream()
  .input(input)
  .format("wav")
  .output("pipe:1")
  .run();

// Pipe Web Stream to a destination (Node.js 18+)
import { Writable } from "node:stream";
const file = fs.createWriteStream("new.wav");
await output.pipeTo(Writable.toWeb(file));
await done;
```

---

### Crossfade Example

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // 2.5 seconds crossfade
  .output("x.mp3")
  .run();
```

### Advanced Streaming Example

```ts
import { FluentStream } from "fluent-streamer";
import { Readable } from "node:stream";

// Stream from HTTP source to response
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
    console.error("Audio stream error:", error);
    res.status(500).send("Streaming failed");
  }
});
```

### Real-time Audio Effects

```ts
import { FluentStream } from "fluent-streamer";

// Create streamer for live audio processing
const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
});

const inputStream = getAudioSource(); // ReadableStream<Uint8Array> or Node.js Readable

const { output, done } = await streamer
  .input(inputStream)
  .audioCodec("pcm_s16le")
  .audioFrequency(44100)
  .audioChannels(2)
  .output("pipe:1")
  .run();

// Adjust audio effects in real-time (property accessors or change* methods)
streamer.volume = 1.5;   // Boost volume by 50%
streamer.bass = 5;       // Increase bass
streamer.treble = -3;    // Reduce treble

// Listen for progress events
streamer.on("progress", (progress) => {
  console.log(`Processing: ${progress.progress}%`);
});

await done;
```

### Fade Effects and Transitions

```ts
import { FluentStream } from "fluent-streamer";

// Fade in/out example
const streamer = new FluentStream()
  .input("background-music.mp3")
  .setVolume(0) // Start silent
  .output("fade-demo.mp3");

const { done } = await streamer.run();

// Fade in over 2 seconds
await new Promise((resolve) => setTimeout(resolve, 1000));
streamer.fadeIn(1, 2000); // Target volume 1, fade time 2000ms

await new Promise((resolve) => setTimeout(resolve, 8000));
streamer.fadeOut(3000); // Fade out over 3 seconds

await done;
```

---

### Audio Effects Control

```ts
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableProgressTracking: true,
  useAudioProcessor: true,
})
  .input("music.mp3")
  .setVolume(1.5)      // Increase volume by 50%
  .setBass(8)          // Boost bass
  .setTreble(-3)       // Cut treble slightly
  .setCompressor(true) // Enable dynamic compression
  .output("enhanced.wav");

const { done } = await streamer.run();
await done;
```

---

## API Highlights

`FluentStream` provides a _fluent_ interface:

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("song.mp3")
  .seekInput(30)          // seek to 30s
  .audioCodec("opus")
  .audioBitrate("128k")
  .output("clip.opus")
  .run();
```

Main methods:
- `.input(src)` — add file/URL/stream input (`string`, `ReadableStream<Uint8Array>`, or Node.js Readable)
- `.output(dst)` — set the output (file path, pipe object, or fd)
- `.audioCodec(codec)` / `.videoCodec(codec)` — set codecs
- `.audioBitrate(bps)` / `.videoBitrate(bps)`
- `.format(fmt)` — set output format (e.g. 'mp3', 'wav')
- `.seekInput(time)` — seek input position
- `.overwrite()` — overwrite output file(s)
- `.map(spec)` — select specific streams
- `.crossfadeAudio(seconds, options?)` — crossfade (audio)
- `.run()` — start processing (async; returns `output`, `done`, `stop`)

---

## Complete API Reference

### Constructor
```ts
new FluentStream(options?: ProcessorOptions)
```
Creates a new FluentStream instance with optional processor options.

**Options:**
- `timeout?: number` - FFmpeg process timeout in seconds
- `enableProgressTracking?: boolean` - Enable progress event emission
- `failFast?: boolean` - Stop processing on first error
- `wallTimeLimit?: number` - Maximum wall clock time limit
- `useAudioProcessor?: boolean` - Enable built-in audio processing
- `audioProcessorOptions?: AudioProcessingOptions` - Audio effect defaults (volume, bass, treble, compressor, sampleRate, channels)
- `logger?: Logger` - Custom logger instance (debug, info, warn, error)
- `verbose?: boolean` - Enable debug log output

### Input/Output Methods

#### `.input(source: string | ReadableStream<Uint8Array> | NodeJS.Readable, options?: InputOptions)`
Add file, URL, blob URL, or stream input.
```ts
// File input
.input('/path/to/audio.mp3')

// HTTP URL with custom headers
.input('https://cdn.com/track.mp3')

// Web Stream input
.input(readableStream)

// Node.js stream input (adapted internally)
.input(fs.createReadStream('input.wav'), { pipeIndex: 0 })
```

**Options:**
- `label?: string` - Input label for identification
- `pipeIndex?: number` - Custom pipe index for streams
- `allowDuplicate?: boolean` - Allow duplicate inputs

#### `.output(destination: string | number | PipeObject)`
Set output destination.
```ts
// File output (auto-overwrites if .overwrite() called)
.output('/path/to/output.mp4')

// Stdout / pipe
.output(FluentStream.stdout)
.output({ pipe: 'pipe:1' })
```

For stream consumers, use `pipe:1` and read the `output` stream returned by `.run()`.

### Audio/Video Configuration

#### `.audioCodec(codec: string)`
Set audio codec: `'aac'`, `'mp3'`, `'opus'`, `'vorbis'`, `'pcm_s16le'`, etc.

#### `.videoCodec(codec: string)`
Set video codec: `'h264'`, `'h265'`, `'vp9'`, `'av1'`, `'mpeg4'`, etc.

#### `.audioBitrate(bitrate: string)`
Set audio bitrate: `'128k'`, `'192k'`, `'320k'`, `'variable'`, etc.

#### `.videoBitrate(bitrate: string)`
Set video bitrate: `'1M'`, `'2M'`, `'5M'`, `'10M'` for high-quality, etc.

#### `.format(format: string)`
Set output container format: `'mp3'`, `'mp4'`, `'wav'`, `'flac'`, `'webm'`, etc.

#### `.audioFrequency(frequency: number)`
Set sample rate: `44100`, `48000`, `96000`, etc.

#### `.audioChannels(channels: number)`
Set channel count: `1` (mono), `2` (stereo), `6` (5.1), `8` (7.1), etc.

### Processing Controls

#### `.seekInput(position: number | string)`
Seek to position in input: `30`, `'00:00:30'`, `'1:30'`, etc.

#### `.duration(time: number | string)`
Limit output duration.

#### `.map(spec: string)`
Select specific streams (advanced FFmpeg feature):
```ts
.map('0:v')  // Select first video stream
.map('1:a')  // Select second audio stream
.map('0')    // Select all streams from first input
```

#### `.noVideo()`, `.noAudio()`
Disable video/audio processing entirely.

#### `.overwrite()`
Allow overwriting existing output files.

#### `.copyCodecs()`
Copy streams without re-encoding (faster, preserves quality).

### Audio Effects (Real-time capable)

#### `.setVolume(value: number)`
Set volume multiplier (0-2): `0.5` (half), `1.0` (normal), `1.5` (50% boost).

#### `.setBass(value: number)`
Adjust bass level (-20 to 20): `0` (neutral), `5` (boost), `-3` (cut).

#### `.setTreble(value: number)`
Adjust treble level (-20 to 20): `0` (neutral), `5` (boost), `-3` (cut).

#### `.setCompressor(enabled: boolean)`
Enable/disable audio compression for consistency.

#### `.setEqualizer(bass, treble, compressor)`
Set all EQ parameters at once.

#### `.fadeIn(targetVolume?: number, durationMs?: number)`
Fade in from current volume to target volume.

#### `.fadeOut(durationMs?: number)`
Fade out to silence.

**Real-time changes (during playback):**
- `.changeVolume(value: number)` — boolean success
- `.changeBass(value: number)` — boolean success
- `.changeTreble(value: number)` — boolean success
- `.changeCompressor(enabled: boolean)` — boolean success
- `.changeEqualizer(bass, treble, compressor)` — boolean success

### Advanced Features

#### `.crossfadeAudio(duration: number, options?)`
Create crossfade between inputs using FFmpeg's `acrossfade` filter.
```ts
.crossfadeAudio(2.5, {
  curve1: 'tri',     // crossfade curve
  curve2: 'tri',
  overlap: true,
  secondInput: 'path/to/second.mp3'
})
```

#### `.complexFilter(graph: string | string[])`
Add complex FFmpeg filter graphs for advanced processing.

### Options & Configuration

#### `.setHeaders(headers: Record<string, string>)`
Set custom HTTP headers for remote sources.

#### `.userAgent(userAgent: string)`
Set User-Agent header for HTTP requests.

#### `.globalOptions(...args)`, `.inputOptions(...args)`, `.outputOptions(...args)`
Add FFmpeg arguments at specific positions.

### Runtime Control

#### `.run(options?) → Promise<FFmpegRunResultExtended>`
Start processing asynchronously. Returns:
```ts
{
  output: ReadableStream<Uint8Array>,  // Output stream when piped
  done: Promise<void>,                 // Settles exactly once on completion/failure
  stop: () => void,                    // User stop/kill helper
  passthrough: ReadableStream<Uint8Array>,
  close: () => Promise<void> | void,
  setVolume?, setBass?, setTreble?, setCompressor?, setEqualizer?, startFade?
}
```

`done` resolves for normal process completion and intentional user `stop()`/`close()` calls. It rejects for spawn/process errors, non-zero FFmpeg exits and timeouts. In Node.js, child process errors such as `spawn ffmpeg ENOENT` are surfaced as process errors instead of ambiguous `code === null` exits.

#### `.clear()`
Reset instance for reuse (required before `.run()` after previous use).

#### `.isDirtyState()`, `.isReady()`
Check instance state.

#### Instance Events
- `'progress'` — Progress updates (if `enableProgressTracking: true`)
- `'error'` — Processing errors
- `'complete'` — Processing finished
- `'start'` — Processing started

### Static Methods

#### Static Pipes
- `FluentStream.stdout` — { pipe: 'stdout' }
- `FluentStream.stderr` — { pipe: 'stderr' }
- `FluentStream.pipe1` — { pipe: 'pipe:1' }
- `FluentStream.pipe2` — { pipe: 'pipe:2' }

---

## Advanced

- **Timeout:** Set the `timeout` option to auto-kill long FFmpeg jobs; timeout termination rejects `done`.
- **Progress:** Get real-time progress events by enabling `.options({ enableProgressTracking: true })` and listening for `"progress"` events.
- **Headers:** Default humanity headers are sent to FFmpeg HTTP(S) sources; override with `.setHeaders(obj)`.
- **Kill/close:** `run()` returns `stop()` and `close()` helpers for intentional user termination; these are tracked separately from FFmpeg errors.

---

## Types & Extensibility

- **Written in TypeScript:** All primary objects (`FluentStream`, `Processor`) are strongly typed
- **Modular layout:** `Fluent/` (API), `Core/` (execution), `Runner/` (platform FFmpeg), `Audio/` (effects)
- **Built-in audio processing:** Volume, EQ, compression via `AudioProcessor` and `AudioEffectController`
- **Extensible runners:** Implement `FFmpegRunner` for custom process spawning or blob resolution

---

## Troubleshooting

### Common Issues

**FFmpeg not found:**
```
Error: spawn ffmpeg ENOENT
```
- Ensure FFmpeg is installed and accessible in PATH
- On Linux/macOS: `which ffmpeg`
- On Windows: Check if ffmpeg.exe is in your PATH
- Alternative: Provide full path with `new FluentStream({ ffmpegPath: '/usr/bin/ffmpeg' })`

**Stream errors with HTTP sources:**
```
[tcp @ 0x...] Connection refused
```
- Verify URL is accessible: `curl -I https://example.com/audio.mp3`
- Check network connectivity and firewall settings
- Some servers block requests without proper headers

**Codec/format not supported:**
```
Unknown encoder 'xxx' or unsupported codec
```
- Verify FFmpeg installation supports the codec: `ffmpeg -codecs | grep xxx`
- Some codecs require additional FFmpeg builds (e.g., non-free codecs)
- Try simpler codecs like `aac` for audio, `h264` for video

**Out of memory during processing:**
```
Cannot allocate memory
```
- Reduce input resolution/frame rate for videos
- Use `copyCodecs()` for passthrough where quality loss is acceptable
- Process in smaller chunks for large files
- Increase system memory limits if possible

**File locking/permissions issues:**
```
Permission denied (file locked)
```
- Ensure output directory is writable
- Close file handles before processing
- On Windows, ensure files aren't open in other applications
- Use unique temporary filenames

### Debugging Tips

**Enable verbose logging:**
```ts
const streamer = new FluentStream({
  logger: console, // Enable console logging
  verbose: true,   // Show debug messages
});
```

**Inspect FFmpeg command:**
```ts
const streamer = new FluentStream()
  .input('in.mp3')
  .audioCodec('aac')
  .output('out.m4a');

console.log('FFmpeg args:', streamer.getArgs());
console.log('Inputs:', streamer.getInputSummary());
```

**Check instance state:**
```ts
console.log('Is dirty:', streamer.isDirtyState());
console.log('Is ready:', streamer.isReady());
console.log('Debug info:', streamer.debugInfo());
```

### Performance Optimization

**For real-time streaming:**
- Use high priority for FFmpeg processes
- Optimize audio-only processing with `.noVideo()`
- Use efficient codecs like `aac` instead of `mp3` for streaming
- Implement buffering to prevent stutter
- Monitor system resources during peak usage

**For file processing:**
- Use multiple CPU cores with FFmpeg threading: `.outputOptions('-threads', '0')`
- Process related tasks in parallel with separate FluentStream instances
- Cache processed results when possible
- Use faster presets: `.outputOptions('-preset', 'fast')`

**Memory management:**
- Use streams for large files instead of loading entire content
- Clean up instances with `.clear()` after use
- Limit concurrent FFmpeg processes
- Monitor memory usage in production

### Compatibility

**Runtimes:** Node.js 18+, Bun, Deno, Browser (with `@ffmpeg/ffmpeg`)  
**FFmpeg versions:** 4.0+ required, 5.0+ recommended (native runtimes)  
**OS support:** Linux, macOS, Windows, Docker containers

**Known limitations:**
- Real-time effects work best with PCM audio streams
- Some advanced filters may not support all input combinations
- HTTP streaming may have buffering delays depending on network
- Large crossfades can be memory-intensive

---

## Contributing

### Development Setup

```bash
git clone https://github.com/Dirold2/fluent-streamer.git
cd fluent-streamer
npm install
npm run build
npm test
```

### Code Style

- **TypeScript:** Strict typing required, oxlint compliant
- **Naming:** CamelCase for classes, camelCase for methods/properties
- **Documentation:** JSDoc comments for all public APIs
- **Tests:** Vitest-based, aim for >90% coverage

### Project Structure

```
src/
  Fluent/     — FluentStream builder API
  Core/       — Processor, ThrottleStream, utilities
  Runner/     — FFmpegRunner + platform runners (node, bun, deno, browser)
  Audio/      — AudioProcessor, AudioEffectController
  Types/      — Shared TypeScript interfaces
```

### Adding Features

1. **Create issue** on GitHub for new features
2. **Implement** in appropriate module (Core, Types, etc.)
3. **Add tests** for new functionality
4. **Update documentation** (README, JSDoc)
5. **Ensure** no breaking changes without major version bump

### Audio Processing Extensions

The `AudioProcessor` class provides built-in audio effects that can be extended:

- **Real-time effects:** Volume, EQ, compression available during playback
- **Custom AudioProcessor:** Extend `AudioProcessor` for new effects
- **Integration:** Effects are applied to PCM audio streams in the processing pipeline

### Reporting Issues

When reporting bugs, please include:
- Node.js and FFmpeg versions
- OS and architecture
- Minimal reproducible example
- Expected vs actual behavior
- Debug output if available

### Features Roadmap

- Enhanced video processing filters
- Improved browser/WASM audio processing
- GPU acceleration for video encoding
- Advanced audio analysis features
- Streaming server integrations
- Plugin system for custom filters and processors

---

## License

MIT © dirold2

---
