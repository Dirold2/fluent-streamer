# Fluent Streamer

[Перейти на русскую версию](https://github.com/Dirold2/fluent-streamer/tree/main/lang/ru)

_Fluent_ FFmpeg wrapper for TypeScript runtimes, **v0.5.4**  
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
It buffers the complete input and runs FFmpeg WASM before exposing output; it does not support live/infinite input streams or real-time output.

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

### Offline Crossfade Example

```ts
import { FluentStream } from "fluent-streamer";

await new FluentStream()
  .input("a.mp3")
  .input("b.mp3")
  .crossfadeAudio(2.5)    // 2.5 seconds crossfade
  .output("x.mp3")
  .run();
```

### Live Crossfade

Crossfade prebuffers approximately 20 ms (at most 1024 frames) of the next source while continuing to output the old source at full gain. The fade frame counter starts only after this buffer is ready (or the next source reaches EOF). Old-decoder retirement runs in the background: transition completion means PCM generation has completed, not decoder cleanup. Session `done` and `stop()` still await every pending retirement and report cleanup failures. This removes cleanup waits from the audio path, but cannot eliminate later network underruns or gaps after the old source runs out.

`await streamer.crossfade(url, time = 3)` requests an immediate transition to another file/URL in an active mixed playback session; it does not wait for the current track's end. The duration is in **seconds** (finite `0…3600`); `0` switches without a fade. The promise resolves after PCM transition generation, not after decoder retirement or the incoming track finishes. You can request another transition after awaiting the previous one; concurrent transitions reject. `result.crossfade?.(url, time)` exposes the same control in an opted-in session.

The optional third argument is `LiveCrossfadeOptions`: `bassHandoff?: boolean` defaults to `false`. Enable it manually with `await streamer.crossfade(url, seconds, { bassHandoff: true, curve: 'equalPower', headroomDb: 3 })`. It uses independent per-channel outgoing/incoming low-band histories to smoothly close the outgoing low band and open the incoming low band over **35–65%** of the fade. The single-pole split (default `bassCutoffHz: 180`) has leakage, not a brick-wall cutoff: the rest of the spectrum still overlaps, and drums/percussive material can still clash. This does not guarantee a clean drum handoff or adjust pitch/playback speed.

Set `enableCrossfade: true` explicitly in the constructor or `run()` options **before playback starts**. This mode keeps the **same `result.output`** across tracks, and `result.done` tracks completion/cleanup of the **whole mixed session**, not each decoder. Live seek preserves the same public result, output, and session `done` in this mode (see [Live seek](#live-seek-seekposition--resultseekposition)). Unlike the offline `.crossfadeAudio()` filter above, this API accepts a new source during playback.

```ts
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  enableCrossfade: true,
  autoDrainOutput: false, // mixed playback always disables auto-drain
  disableThrottling: true, // a clocked player supplies pacing/backpressure
});
const result = await streamer
  .input("first.mp3") // exactly one file/URL input, passed as an FFmpeg argument
  .audioCodec("pcm_s16le")
  .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
  .output("pipe:1")
  .run();

const player = spawn("ffplay", [
  "-nodisp", "-autoexit", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
], { stdio: ["pipe", "ignore", "inherit"] });
player.on("error", (error) => console.error("Player failed:", error));

// Start the consumer BEFORE awaiting any transition; do not await playback here.
const playback = result.output.pipeTo(Writable.toWeb(player.stdin));
try {
  // In an application, request this from a user action/timer BEFORE current EOF.
  await streamer.crossfade("second.mp3", 3);
  await streamer.crossfade("third.mp3", 0); // repeat after await; same output
  // Only await session completion once no more transitions are wanted.
  await Promise.all([playback, result.done]);
} finally {
  await result.stop();
  player.kill();
}
```

**Requirements and limits:**
- Use exactly one `.input(fileOrURL)` represented by `-i` in the FFmpeg arguments, one stdout output `pipe:1`, and no complex filters or extra inputs. Raw stream, pipe, and blob inputs are unsupported.
- Explicitly configure `pcm_s16le`, `-f s16le`, `-ar 48000`, and `-ac 2` as above. If overriding `audioProcessorOptions.sampleRate`/`channels`, explicitly match `-ar`/`-ac` and the consumer format. Built-in DSP is optional; enable `useAudioProcessor: true` for karaoke/EQ and other effects.
- Keep the consumer pipeline flowing **before and throughout `await crossfade()` and `await seek()`**. Without consumption, backpressure stalls the fade and its promise (even a zero-duration switch needs output demand). Auto-drain is disabled in this mode. Do **not** wait for `result.done` before requesting the next track: by then the session has ended.
- Trigger transitions before EOF yourself. This is not an automatic track queue, DJ beat matching, or end-of-track scheduler. An input reaching EOF during a fade contributes silence for the remaining fade frames.
- Two FFmpeg decoders overlap during transitions, increasing CPU use and potentially simultaneous network traffic. Decoder startup and URL warmup can delay audio; network gapless playback is **not guaranteed**.
- The browser/WASM runner buffers input/output rather than streaming live audio; it is not a live-crossfade playback backend.

### Prepared automix

Prepare the next queue entry **early**, while the live-crossfade consumer above keeps reading the same `result.output`. `prepareAutomix()` is an instance method on `FluentStream`, not a run-result method; it requires the same opted-in PCM session and replayable file/URL inputs.

```ts
import {
  analyzePcm, analyzePcmAsync, analyzeTrack, planAutomix,
  type DjAnalysis, type DjAnalysisOptions, type PcmAnalysisOptions, type AutomixPlan,
  type PrepareAutomixOptions, type PreparedAutomix,
  type AutomixDiagnostic, type AutomixFallbackReason,
} from "fluent-streamer";

// Application queue handler: nextUrl and optional incomingDurationMs come from
// queue metadata; currentPositionMs() returns the current source position in ms.
const preparationAbort = new AbortController();
const prepared = await streamer.prepareAutomix(nextUrl, {
  outgoingRemainingMs: currentDurationMs - currentPositionMs(), // sample NOW
  incomingDurationMs, // optional; omit if unknown
  fallbackSeconds: 8,
  onDiagnostic: (diagnostic: AutomixDiagnostic) => {
    console.log("Automix decision:", diagnostic);
  },
  signal: preparationAbort.signal,
});
// Old audio continues during analysis/prebuffering and while prepared is ready.
// If the queue entry is replaced before start:
if (nextUrl !== queue.nextUrl) {
  await prepared.cancel();
} else {
  try {
    await prepared.start(); // arms the PCM schedule; resolves after the overlap
  } catch (error) {
    await prepared.cancel().catch(() => {});
    console.error("Automix did not complete:", error); // reassess live queue/timing
  }
}
// A replacement while prepareAutomix is still pending must call
// preparationAbort.abort(), handle its rejection, then prepare the new entry.
```

- `outgoingRemainingMs` is the **actual remaining duration sampled at the call**, not the full track duration or a future timer delay. Preparation subtracts PCM progress during analysis. Keep consuming output throughout preparation and `start()`; do not await session `done` first.
- Preparation analyzes both sources (unless supplied as `outgoingAnalysis` / `incomingAnalysis`), plans a cue, and prebuffers the incoming decoder without fading. It reserves the transition: seek, crossfade, and another preparation reject while preparing/ready and through the started transition. Start or cancel promptly. `cancel()` is idempotent before start; after start it rejects and cannot undo the transition.
- There is **no automatic start at EOF**, and preparation does not hold EOF open. Call `start()` while playback is still active; no `setTimeout` is needed. It schedules against consumed/generated PCM frames, not audible device time. Late arming can move a quantized start to a later beat; if the overlap no longer fits with the reserved one-second tail, `start()` cancels and rejects as stale rather than silently changing the decoded cue. Handle preparation/start rejection and reassess remaining time before retrying.
- Decoder configuration and effects are snapshotted during preparation. Later setters affect only the active decoder until the prepared track becomes active. Cached analyses must describe the source from its **original beginning**, not the post-seek excerpt. `plan.startMs`, `cueMs`, and `dropMs` are source-relative absolute milliseconds; the session translates its seek origin to mixer frames. `plan.seconds` is seconds, not milliseconds. Subsequent seeks remain absolute in the incoming track.

**Analysis and planning.** Use `await analyzePcmAsync(pcm: Int16Array, sampleRate, options?: PcmAnalysisOptions)` for CPU analysis during playback. It runs the shared analyzer in a dedicated worker and copies the analyzed input rather than transferring/detaching the caller's buffer. `PcmAnalysisOptions` has `signal?: AbortSignal` and `timeout?: number`: the default 25,000 ms deadline includes worker startup and the whole worker job. Timeout must be finite and positive. Abort/timeout rejects and terminates the worker; each job also terminates its worker before settling normally. `analyzePcm(pcm, sampleRate)` remains explicitly synchronous for deliberate offline use: it blocks the calling/main thread and is not a playback-safe substitute. Both APIs require a finite positive sample rate.

`await analyzeTrack(fileOrURL, { ffmpegPath?, headers?, timeout?, signal? })` decodes through the runtime-selected `Processor`/runner, then automatically runs CPU analysis in a worker. `prepareAutomix()` automatically uses this path for each uncached source; callers do not need to opt in. Worker startup/execution errors reject: there is **no synchronous fallback**. Track analysis requires available FFmpeg (or the runner's FFmpeg backend), uses analysis runner defaults rather than all playback/run options, and does not apply playback effects. Its default 25-second **total deadline covers decoder startup, decoding, worker startup, and analysis**, not separate 25-second budgets per phase. Abort/timeout stops decoding and terminates an active analysis worker. Decoded output is capped at 720,000 bytes: 90 seconds of 4 kHz mono s16le. This is not a network download-size guarantee.

**Worker deployment.** Node uses `node:worker_threads`; compiled packages resolve the separate `dist/Audio/analysis/DjAnalysisWorker.js` entry and its `DjAnalysisCore.js` dependency. Bundlers/deployments must preserve these worker/core assets and their relative URLs beside the compiled client, or explicitly arrange equivalent worker asset resolution; bundling only the main entry is insufficient. Running the TypeScript source directly requires **Node ≥22.18**; older Node versions must use a compiled build (subject to the package's normal runtime requirements). The non-Node branch uses a module Web Worker, but Bun, Deno, and browser/Web Worker execution remain **unverified**, not a compatibility promise. Missing Worker support or unavailable worker assets cause rejection, never main-thread analysis.

All analysis entry points inspect at most the **first 90 seconds** and abstain on less than **8 seconds** or unreliable material. `DjAnalysis` contains `bpm`, `beatPhaseMs`, `dropMs` (nullable), their respective `bpmConfidence`, `beatPhaseConfidence`, `dropConfidence` (0–1 heuristics, not calibrated probabilities), and `analyzedDurationMs`. Spectral onsets estimate tempo/phase; sustained energy rises suggest a drop. Half/double-tempo ambiguity, weak onsets, or changing tempo intentionally lower confidence or produce nulls: fallback is expected, not a detection failure to bypass.

`planAutomix({ outgoingAnalysis, incomingAnalysis, outgoingPositionMs, outgoingRemainingMs, incomingDurationMs?, fallbackSeconds, explicitDropMs?, onDiagnostic? })` is pure timing advice and returns `AutomixPlan | null`. Its fields are `seconds`, `cueMs`, `dropMs`, `reason` (`energy-entry`, `tempo-phrase`, or `crossfade`), `startMs`, and `beatPeriodMs` (null for fallback).

- Both tracks must have valid 70–180 BPM grids with **BPM and phase confidences ≥ 0.65**, and faster/slower tempo ratio ≤ 1.03 (at most 3% apart). Automatic incoming drops additionally need confidence ≥ 0.7 and must lie inside the analyzed window. `explicitDropMs` overrides drop detection only after both grid/tempo gates pass.
- Low confidence or incompatible tempos choose a plain crossfade from incoming **cue 0**, with **no drop seek, even if an explicit drop was supplied**, using the configured fallback length subject to duration caps. Fallback defaults to 8 seconds in `prepareAutomix`; invalid planner fallback lengths also use 8. This fallback can still overlap percussive material; it is not automatically a perfect mix. Invalid outgoing timing/known incoming duration returns null. All overlaps are capped at 16 seconds, reserve one outgoing second, and use at most a quarter of a known incoming duration.
- Quantized plans use up to 16 beats, preferring four-beat bars. For unequal reliable BPMs within the tempo gate, the planner limits estimated drift to **1/16 of the shorter beat**, shortening the overlap and using whole beats when a bar cannot fit. If no grid-aligned overlap fits, these unequal-tempo plans use a short ordinary **cue-0 crossfade of at most 1 second**, not the longer configured fallback. Equal-tempo plans retain four-beat groups and use the configured fallback if they cannot fit. Four beats are only treated as a bar: this is **not bar/downbeat detection, pitch/speed adjustment, time stretching, or guaranteed persistent beat sync**. The drift budget assumes stable tempo, not measured phase error; tempo can drift, especially beyond the analyzed excerpt. Drop lead-in is approximate, not a guarantee that the drop lands on the fade endpoint.
- `prepareAutomix()` automatically enables `bassHandoff: true` with smooth outgoing bass attenuation to **−12 dB**, `equalPower` overlap, and **3 dB** midpoint headroom. Independent outgoing/incoming low-band histories support the smooth **35–65%** handoff: outgoing lows close as incoming lows open. This is a leaky single-pole split, not brick-wall isolation or a full frequency exchange. Full-range envelopes still overlap, so drums/percussive material may overlap; neither clean drum separation nor an automatically perfect mix is guaranteed. No pitch/playback-speed adjustment or time stretching is applied.

**Automix decision diagnostics.** `PrepareAutomixOptions.onDiagnostic?: (diagnostic: AutomixDiagnostic) => void` observes the planning decision independently of `verbose`. It is called exactly once when planning runs, even if the planner returns `null` (in which case `prepareAutomix()` rejects); failures or cancellation before planning do not emit a decision. Callback exceptions are swallowed and cannot change the plan or interrupt preparation. Direct `planAutomix()` calls also accept `onDiagnostic` with the same once-per-decision behavior, including null results. `AutomixDiagnostic` and `AutomixFallbackReason` are exported public types.

- `outgoing` and `incoming` contain scalar analysis snapshots of **both tracks**: `bpm`, `bpmConfidence`, `beatPhaseMs`, `beatPhaseConfidence`, `dropMs`, `dropConfidence`, and `analyzedDurationMs`. Missing/non-finite numbers become `null`; no source URLs are included. `outgoingGridIssues` / `incomingGridIssues` explain grid validation failures. `timing` records `outgoingPositionMs`, `outgoingRemainingMs`, `incomingDurationMs`, `fallbackSeconds`, and `explicitDropMs`, also sanitized to finite numbers or `null`.
- `fallbackReason: AutomixFallbackReason | null` is one of `unreliable-both-grids`, `unreliable-outgoing-grid`, `unreliable-incoming-grid`, `tempo-mismatch`, `insufficient-overlap`, `insufficient-grid-window`, `incoming-duration-limit`, or `invalid-timing`; it is `null` when no fallback/rejection reason applies. `outcome` is the resulting plan reason (`energy-entry`, `tempo-phrase`, or `crossfade`), or `null` when no plan is possible.
- `tempoRatio` is faster/slower positive finite BPM (or `null`), even for unreliable grids. `octaveRelated` flags ratios from 1.85 to 2.15: it is **diagnostic only**, not tempo correction, permission to bypass confidence gates, or an automatic drop seek.
- With `verbose: true`, the configured logger also receives `logger.debug("[tag] Automix decision", { code: "FluentStream-automix-decision", detail: diagnostic })`, where `tag` is the effective `loggerTag` (default `FluentStream`). Logger exceptions are swallowed too. These decision diagnostics are separate from `getPlaybackStats()` mixer/buffering statistics below.

Diagnostics do **not** relax the conservative safety thresholds above or change fallback behavior: unreliable grids or incompatible tempos still use incoming **cue 0 with no drop seek**, even with `explicitDropMs`.

**Cost and migration.** Uncached preparation separately opens/decodes outgoing and incoming sources, then opens the incoming source again for playback. Remote requests expose URLs/headers to the configured media endpoint and use additional network traffic and CPU; there is no external analysis service or built-in analysis cache. Cache/reuse trusted `DjAnalysis` in the caller (for example, using `analyzeTrack` ahead of time); `analyzePcmAsync` avoids a separate library download/decode if mono PCM is already available without running the CPU analyzer on the main thread. For bots, replace local analyzer/planner imports with the public exports above and remove duplicate implementations in the bot project—keep one library implementation. Bot files outside this repository must be migrated in that project. Their playback/buffering settings and downstream player are not available here: worker isolation alone does not verify that a bot's audible stutters have disappeared.

### Playback diagnostics and responsiveness benchmark

`streamer.getPlaybackStats()` returns `PlaybackMixerStats | null`: a frozen point-in-time snapshot for the current mixed playback session, or `null` outside one. Counters span that mixer session and do not reset when read; take another snapshot to observe changes. The exported interface matches `src/Audio/PlaybackMixer.ts`:

```ts
interface PlaybackMixerStats {
  readonly emittedFrames: number;
  readonly pullCount: number;
  readonly maxPullMs: number;
  readonly latePullCount: number;
  readonly deadlineMissCount: number;
  readonly pcmWaitMs: number;
  readonly maxPcmWaitMs: number;
  readonly frameShortageCount: number;
  readonly preparationWaitCount: number;
  readonly preparationWaitMs: number;
  readonly pendingReadCount: number;
  readonly prebufferedFrames: number;
  readonly preparing: boolean;
  readonly cleanupPending: boolean;
}
```

- `emittedFrames` counts successfully enqueued PCM frames, including fades/silence, not discarded work. `pullCount` includes first demand and terminal pulls (EOF, errors, cancellation).
- `maxPullMs` and `maxPcmWaitMs` measure the longest generation pull; `pcmWaitMs` sums pull duration including PCM/preparation waits, finalized when each pull ends. **Time between consumer reads is excluded.** `latePullCount` counts pulls longer than `max(20 ms, duration of PCM enqueued by that pull)`; `deadlineMissCount` counts pulls strictly longer than the fixed 20 ms deadline (960 frames at 48 kHz), including first/terminal pulls.
- `frameShortageCount` counts current-source frame waits exceeding 20 ms before the pull has produced output. Immediate/small reads are not shortages; delayed EOF, errors, or cancellation can count. `preparationWaitCount` / `preparationWaitMs` describe EOF waits for a held replacement or incoming crossfade warmup.
- `pendingReadCount` includes live upstream reads, including background prebuffering. `prebufferedFrames` counts complete frames in explicit warmup queues, not upstream chunks or output. `preparing` and `cleanupPending` report current preparation/cleanup state.

Deadline misses and frame shortages are **not physical player underruns**. Event-loop starvation between pulls may not appear in generation-only timings. Measure consumer delivery against a separate fixed clock, alongside event-loop delay and downstream/device telemetry; consumer pauses and external buffering are separate from mixer generation.

From the repository root, run the reproducible synthetic comparison:

```sh
./node_modules/.bin/tsc && node scripts/bench-dj-responsiveness.mjs
```

It compares no-analysis baseline, two consecutive synchronous analyses, and two concurrent worker analyses on deterministic seeded 90-second mono tracks through the actual `PlaybackMixer` with a paced synthetic PCM source. The JSON reports environment, a shared calibration-sized observation window, fixed 20 ms consumer opportunities/misses, event-loop delay/utilization, and mixer stats. Async elapsed time includes startup, copying, DSP, IPC, and termination; the empty-job startup/IPC/termination proxy is separate, not pure startup or subtracted compute time. Expired consumer slots are skipped, not replayed in a catch-up burst.

This is a short local responsiveness observation, **not a worst-case input or performance guarantee**: 90 seconds is the analysis cap, not maximum computational complexity. There is no FFmpeg, network, device, or physical-underrun measurement; the direct mixer bypasses Processor throttling/settings. Repeat on the target deployment and compare loop delay and consumer misses, not just analysis throughput or mixer counters. No timing threshold is asserted and machine-specific results are not API guarantees.

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

Built-in DSP processes **raw signed 16-bit little-endian PCM from FFmpeg stdout**, not encoded MP3/AAC, WAV headers, or files written directly by FFmpeg. Match FFmpeg output, `audioProcessorOptions`, and the player format explicitly. Only mono and stereo are supported.

The following Node.js example uses `ffplay` as a clocked consumer; both binaries must be installed. The browser/WASM runner buffers input and does not support live playback.

```ts
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { FluentStream } from "fluent-streamer";

const streamer = new FluentStream({
  useAudioProcessor: true,
  disableThrottling: true, // the player controls playback speed via backpressure
  autoDrainOutput: false,
  audioProcessorOptions: {
    volume: 1,
    bass: 0,
    mids: 0,
    treble: 0,
    compressor: false,
    normalize: false,
    sampleRate: 48000,
    channels: 2,
  },
});

const player = spawn("ffplay", [
  "-nodisp", "-autoexit", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
], { stdio: ["pipe", "ignore", "inherit"] });
player.on("error", (error) => console.error("Player failed:", error));

const { output, done, stop } = await streamer
  .input("https://example.com/music.mp3")
  .audioCodec("pcm_s16le")
  .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
  .output("pipe:1")
  .run();

try {
  const playback = output.pipeTo(Writable.toWeb(player.stdin));
  streamer.setBass(5).setMids(4).setTreble(-3);
  await Promise.all([playback, done]);
} finally {
  await stop();
  player.kill();
}
```

If supplying `audioProcessorOptions`, TypeScript requires `volume`, `bass`, `treble`, `compressor`, and `normalize`; `mids`, `karaoke`, `sampleRate`, and `channels` are optional. Setting these format options does not configure FFmpeg output: specify matching `-ar`, `-ac`, codec, and raw format as above. Volume is clamped to `0…1`.

Values in `audioProcessorOptions` are not all forwarded by the current Fluent pipeline: initial `normalize` is reset to `false`, and `cloneInput`, `headers`, low-pass options, and `fade` are not passed to the built-in DSP. Enable normalization after `run()` via `result.setNormalize?.(true)` or `streamer.changeNormalize(true)`. A directly constructed `AudioProcessor` does honor its initial `normalize` and `cloneInput` settings.

### Karaoke (Center Cancellation)

Enable `useAudioProcessor: true` with `audioProcessorOptions.karaoke: true` (default: `false`) in the raw PCM pipeline above, or configure it before `run()` with `streamer.setKaraoke(true)`. No restart is needed for live changes:

```ts
streamer.setKaraoke(true);       // chainable; initial or live setting
streamer.karaoke = false;       // equivalent read/write accessor
const enabled = streamer.karaoke;
result.setKaraoke?.(true);      // run() result; when a processor is attached
streamer.changeKaraoke(false);  // returns false without an attached runtime setter
```

`AudioProcessor` also exposes `setKaraoke(enabled)` and a read/write `karaoke` accessor. `FluentAudioState` supports the same state, chainable setter, and `changeKaraoke()` control. Fluent karaoke state is included in cached options/debug state for subsequent runs and preserved across live seek restarts.

Karaoke uses mid/side processing: it preserves the side signal, applies frequency-selective attenuation to the mid signal, then reconstructs stereo before volume, EQ, and compression. Shelving filters shape attenuation over approximately **180 Hz–6 kHz**, with a nominal center depth of **-24 dB**. An adaptive coherence estimate based on overall mid-versus-side energy—not per-frequency analysis—reduces suppression on hard-panned signals. **Mono bypasses karaoke**; other enabled effects still apply.

This is **center attenuation, not ML vocal isolation or source separation**. Centered instruments can also be attenuated, while panned vocals and vocal reverb can remain. Stereo is retained, but loudness and timbre can change; neither complete vocal removal nor listening quality is guaranteed. Reconstruction can produce peaks that clip even when the original PCM did not; the processor saturates samples to the 16-bit range rather than allowing integer wraparound. This processing uses more CPU than the old simple subtraction.

Runtime toggles ramp the wet mix over **50 ms of processed audio**; an initially enabled setting takes effect immediately. Already queued audio is not reprocessed. Existing PCM buffering, 16-bit quantization, normalization, and saturation rules still apply. Start with neutral EQ and normalization/compression disabled to evaluate the attenuation; these effects remain available but alter the residual sound.

### Fade Effects and Transitions

Use the PCM pipeline and consumer above. Start at volume zero, then invoke fades while output is being consumed:

```ts
// Before run():
streamer.setVolume(0);

// After run(), while output.pipeTo(...) is active:
streamer.fadeIn(1, 2000);
// Later, when a fade-out is needed:
streamer.fadeOut(3000);
```

Fade durations use processed audio frames, not system time. Without an output consumer, backpressure stops processing and fades cannot advance. For file encoding, use FFmpeg filters instead of built-in live DSP.

### Audio Effects Control

```ts
// Before run(): initial settings apply immediately.
streamer
  .setVolume(0.8)
  .setBass(8)
  .setMids(4)
  .setTreble(-3)
  .setCompressor(true);

// During PCM playback: EQ transitions take 50 ms of processed audio.
streamer.setBass(0).setMids(-2).setTreble(5);
streamer.changeNormalize(true); // live update; returns whether a run is attached
```

Normalization is bounded peak control, not an EBU R128/LUFS loudness normalizer. Gain is limited to ×4 with a -1 dBFS input-peak target. Signals at or below -60 dBFS are not amplified. Gain reduction is immediate; recovery uses a 0.5-second audio-duration time constant. Silence and enable/disable transitions reset gain history. EQ and volume processing affect the final peak, so -1 dBFS is not a guaranteed output ceiling; final PCM saturation remains in place.

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
- `.seekInput(time)` — set the input start position before `.run()`
- `await streamer.seek(time)` — live seek; returns a new run result and output stream
- `.overwrite()` — overwrite output file(s)
- `.map(spec)` — select specific streams
- `.crossfadeAudio(seconds, options?)` — offline FFmpeg crossfade filter
- `await streamer.crossfade(url, seconds = 3)` — live transition with `enableCrossfade: true`
- `.setKaraoke(enabled)` / `.karaoke` — initial/live center cancellation
- `.run()` — start processing (async; returns `output`, `done`, `stop`)

---

## Complete API Reference

### Constructor
```ts
new FluentStream(options?: ProcessorOptions)
```
Creates a new FluentStream instance with optional processor options.

**Options:**
- `timeout?: number` - FFmpeg process timeout in milliseconds (`0` disables it)
- `enableProgressTracking?: boolean` - Enable progress event emission
- `failFast?: boolean` - Stop processing on first error
- `wallTimeLimit?: number` - Maximum wall clock time limit
- `useAudioProcessor?: boolean` - Enable built-in audio processing
- `disableThrottling?: boolean` - Defaults to `true`. Set `false` to pace PCM output by its configured byte rate; this is not a jitter buffer.
- `autoDrainOutput?: boolean` - Defaults to `true`. An unlocked output is automatically drained after 100 ms. Set `false` when attaching your own player or stream consumer.
- `enableCrossfade?: boolean` - Explicit opt-in (default `false`) for stable mixed PCM output and live `.crossfade()`; disables auto-drain. See [Live Crossfade](#live-crossfade).
- `audioProcessorOptions?: AudioProcessingOptions` - Audio effect defaults (volume, bass, treble, mids, compressor, normalize, karaoke, sampleRate, channels, cloneInput)
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
The built-in PCM audio processor supports `1` (mono) or `2` (stereo) channels. Other channel counts are rejected rather than partially applying effects.

### Processing Controls

#### `.seekInput(position: number | string)`
Set the input start position **before `.run()`**: `30`, `'00:00:30'`, `'1:30'`, etc. This is pre-run configuration, not a live playback seek; use `await streamer.seek(position)` for an active run.

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
Set volume multiplier, clamped to `0…1`: `0` (mute), `0.5` (half), `1` (normal). Values above `1` are clamped rather than boosted.

#### `.setBass(value: number)`
Adjust bass level (-20 to 20): `0` (neutral), `5` (boost), `-3` (cut).

#### `.setTreble(value: number)`
Adjust treble level (-20 to 20): `0` (neutral), `5` (boost), `-3` (cut).

#### `.setMids(value: number)`
Adjust midrange level (-20 to 20): `0` (neutral), positive values boost, negative values cut. Also available as the `mids` property and optional `audioProcessorOptions.mids` (default `0`). Like bass/treble, Fluent setters retain the value for subsequent runs. The run result exposes `setMids(value)` for live updates and retains its value for the next run of the same `Processor`.

`AudioProcessor.setEqualizer(bass, treble, compressor)` keeps its existing signature and does not change mids; use `setMids(value)` separately.

Live changes to bass, mids, and treble automatically transition over **50 ms of processed audio**, including transitions back to neutral. Repeated changes continue from the current transition. Initial constructor settings apply immediately; smoothing does not delay or buffer the audio stream and does not use wall-clock time.

#### `.setCompressor(enabled: boolean)`
Enable/disable audio compression for consistency.

#### `result.setNormalize(enabled: boolean)` / `.changeNormalize(enabled: boolean)`
Enable/disable automatic peak normalization during a run. Use `setNormalize(enabled)` on the run result or `streamer.changeNormalize(enabled)` (returns success). FluentStream does not expose a `normalize` property or chainable `setNormalize()` method.

#### `.setKaraoke(enabled: boolean)` / `.karaoke` / `result.setKaraoke?.(enabled)`
Configure or toggle center cancellation with `useAudioProcessor: true`. `.setKaraoke()` is chainable; `.karaoke` is a read/write accessor. `.changeKaraoke()` returns whether a runtime setter is attached. See [Karaoke](#karaoke-center-cancellation) for DSP behavior and limitations.

#### `.fadeIn(targetVolume?: number, durationMs?: number)`
Fade in from current volume to target volume.

#### `.fadeOut(durationMs?: number)`
Fade out to silence.

**Real-time changes (during playback):**
- `.changeVolume(value: number)` — boolean success
- `.changeBass(value: number)` — boolean success
- `.changeTreble(value: number)` — boolean success
- `.changeMids(value: number)` — boolean success
- `.changeCompressor(enabled: boolean)` — boolean success
- `.changeNormalize(enabled: boolean)` — boolean success

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
  seek?: (position: number | string) => Promise<FFmpegRunResultExtended>,
  crossfade?: (url: string, time?: number) => Promise<void>, // Opted-in mixed session
  setVolume?, setBass?, setTreble?, setMids?, setCompressor?, setNormalize?, setKaraoke?, startFade?
}
```

`done` resolves for normal process completion and intentional user `stop()`/`close()` calls. It rejects for spawn/process errors, non-zero FFmpeg exits and timeouts. In Node.js, child process errors such as `spawn ffmpeg ENOENT` are surfaced as process errors instead of ambiguous `code === null` exits.

#### Live seek: `.seek(position)` / `result.seek?.(position)`

Both `await streamer.seek(90)` and `await result.seek?.('00:01:30')` seek to an **absolute** input position, not a relative offset. The optional result method must be present to use it; optional chaining returns `undefined` otherwise.

**Ordinary seek (`enableCrossfade` off, unchanged):** FFmpeg restarts and returns a **new `FFmpegRunResultExtended`**, with its own `output`, `done`, `stop`, and other runtime controls. Runtime volume, EQ (bass/mids/treble), compressor, karaoke, and normalize settings are preserved across the restart. Replace the result and output as shown below:

```ts
const streamer = new FluentStream({ autoDrainOutput: false })
  .input('song.mp3')
  .audioCodec('pcm_s16le')
  .format('s16le')
  .output('pipe:1');

let result = await streamer.run();
let output = result.output;
// Connect output to your player; keep ownership of that consumer.

result = await streamer.seek(90);
output = result.output;
// Detach the old consumer, clear the player's queued audio, and connect NEW output.

const next = await result.seek?.('00:01:30');
if (next) {
  result = next;
  output = result.output;
  // Again replace the consumer and clear the player's queue before playing NEW output.
}
// Use the current result.done / result.stop / other controls from now on.
```

For ordinary seek, the old output stream ends during a seek. Replace the consumed `output` and clear any external player queue yourself; the library does **not** automatically clear it and does **not** guarantee gapless playback. `autoDrainOutput: false` is recommended when your application consumes the output.

**Lifecycle (ordinary, non-mixed runs):** `done` belongs to one FFmpeg run, not the entire playback session. Settlement of the old `done` during a restart does **not** mean that the playback session has ended. Do not attach unconditional session/player teardown to an old result's `done`; track the replacement result and handle seek transitions separately.

**Mixed seek (`enableCrossfade: true`):** Both seek entry points return the **same public result**, with the **same `output` and `done`**. After a completed crossfade, the position is absolute within the **current track**, not the original track or the mixed-session timeline. Keep the existing output consumer running continuously **before and throughout `await seek()`**; do not detach it or wait for seek to finish before consuming. Backpressure can otherwise stall completion. `done` still covers the whole mixed session, not the replacement decoder.

Mixed seek applies a 20 ms fade-out to the old audio, switches decoders at silence, then applies a 20 ms fade-in from the requested position. These sequential envelopes are counted in audio frames and do not modify the user volume or DSP fade state. `await seek()` resolves after fade-in PCM is generated (not after physical playback). The consumer must keep reading. Ordinary replacement-output seek does not apply these mixer envelopes.


For example, in the [Live Crossfade](#live-crossfade) setup above, replace the `try` body with:

```ts
// playback is already consuming result.output and must keep running.
await streamer.crossfade("second.mp3", 3);
const sought = await streamer.seek(90); // absolute 90 seconds into second.mp3
console.assert(sought === result);
console.assert(sought.output === result.output && sought.done === result.done);
await result.seek?.("00:00:30"); // same behavior; absolute 30 seconds into second.mp3
// No result/output replacement or consumer reconnection for mixed seek.
await Promise.all([playback, result.done]);
```

The library does **not flush PCM already queued by an external player**. Old frames may continue during decoder warmup, and network startup may cause an audible gap; preserving stream identity does **not** guarantee an immediate audible jump or gapless playback.

A seek during an active fade rejects. While a seek is in progress, crossfade and a second seek reject. These operations do **not** cancel or supersede an in-progress transition; await completion before requesting another operation.

**Limits and errors:**
- Only an **active** run with a **single replayable file/URL input**, stdout output (`pipe:1`), and **no complex filters** supports live seek.
- Raw stream and blob inputs are unsupported. A live/non-seekable URL server may fail even though the input is a URL.
- The position must be a finite number of seconds `>= 0`, or a time string such as `'00:01:30'`; it is not a relative offset.
- Concurrent seeks reject. For ordinary seek, seeking through a stale result (one superseded by a seek) rejects; always retain the new result. Mixed seek retains the existing public result instead.
- `.seekInput()` remains pre-run configuration; it does not replace this live-seek API.

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

### Playback Latency and Stuttering

For URL/file playback through a clocked player, start without `-re`, `-fflags nobuffer`, or `-flags low_delay`. `-re` limits input reading to real time and reduces the opportunity to prepare audio ahead of playback; it is not needed merely because output is played in real time. These flags are not a general cure for latency. Live sources and publishing pipelines may require different settings.

- With a player that controls timing and supports backpressure, keep `disableThrottling: true` and use `autoDrainOutput: false`.
- If you need library-side PCM pacing, set `disableThrottling: false`. Do not blindly combine multiple pacing layers. Throttling cannot compensate for unavailable network data and is not a jitter buffer.
- In your player, consider a bounded **100–200 ms startup buffer**, trading initial latency for underrun resistance. Respect backpressure rather than accumulating an unbounded queue.
- At 48000 Hz, stereo, s16le: **192000 bytes/s**, **3840 bytes per 20 ms**, and **19200–38400 bytes per 100–200 ms**. FFmpeg chunks have variable sizes: do not treat each chunk as one fixed-duration packet. Preserve incomplete frames when repacketizing.
- Match the FFmpeg output, DSP options, and consumer format. `.audioFrequency()` / `.audioChannels()` configure FFmpeg arguments; they do not synchronize the DSP options automatically.
- Distinguish pitch/speed changes from delivery gaps. Log chunk byte counts, arrival times, player buffer depth, and underruns using monotonic clocks. Inspect FFmpeg stderr for reconnects and decoding errors.
- Normalization measures the incoming signal before the built-in EQ. FFmpeg `volume=0.1` attenuates input by 20 dB and normalization may partly compensate for it; this changes loudness, not playback speed.

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
- Real-time effects require raw signed 16-bit little-endian PCM on stdout, with matching sample rate and mono/stereo channels; encoded output is not decoded by the built-in DSP.
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


### Opt-in mixtape transitions

Live mixed playback also accepts `crossfade(nextUrl, seconds, options)` on both
`FluentStream` and its active run result. `LiveCrossfadeOptions` is exported as a type.
Keep consuming the same `result.output` while awaiting the transition:

```ts
await result.crossfade!(nextUrl, 8, {
  startTime: 42.5,             // incoming cue, absolute seconds into nextUrl
  curve: "equalPower",        // cosine/sine overlap instead of default linear
  outgoingBassDb: -24,        // progressively clear outgoing bass during overlap
  bassCutoffHz: 180,          // low-band split frequency
  headroomDb: 3,              // midpoint headroom, smoothly unity at both endpoints
});
```

Defaults remain linear with no bass attenuation, bass handoff, or headroom reduction. Cue defaults
to the beginning of the incoming file. `startTime` must be finite and nonnegative;
`outgoingBassDb` is -60..0 dB, `bassCutoffHz` is 20..1000 Hz (internally capped below
Nyquist), and `headroomDb` is 0..12 dB. `bassHandoff?: boolean` defaults to `false`.
Bass uses a per-channel one-pole low-band split with a smooth progressive outgoing
attenuation envelope. Without handoff, incoming EQ is unchanged; with
`bassHandoff: true`, independent incoming low-band histories allow outgoing lows
to close as incoming lows open smoothly over 35–65% of the fade. This leaky split
is not brick-wall isolation: full-range envelopes and drums can still overlap.
Shaped transitions use a channel-linked instantaneous peak guard to prevent PCM
clipping/wraparound. This is not a lookahead mastering limiter; dense correlated
material may still sound compressed. Headroom reduces how often that guard acts.
Effects end with the overlap; normal track volume/EQ remains unchanged.

The incoming decoder prebuffers up to 20 ms / 1024 PCM frames while outgoing audio
continues. The fade clock starts once that warmup completes, not necessarily at the
instant of the call. For advance analysis/prebuffering and PCM-frame scheduling,
use [prepared automix](#prepared-automix); plain `crossfade()` does not analyze BPM
or drops. Slow network startup can still cause gaps at outgoing EOF. Neither API
performs time stretching or pitch-changing resampling. A cue identifies the start
of incoming overlap, not a promise to land its drop at the fade endpoint.
Seeking after completion remains absolute within the incoming track.
