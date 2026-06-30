# Changelog

All notable changes to this project will be documented in this file.

## [0.5.4] – 2026-07-01

### Added
- **Normalizer audio effect:** New `normalize` property on `FluentStream` and `AudioProcessor` for automatic peak normalization of PCM audio. Accessible via `.setNormalize(true)` on the `run()` result and `FluentStream` property accessor.
- **`cloneInput` option:** Added to `AudioProcessingOptions` — when `true`, the audio processor clones input buffers before processing to avoid mutation of shared `Uint8Array` instances.
- **`FluentAudioState` class:** Extracted audio state management from `FluentStream` into a dedicated class, reducing `FluentStream` boilerplate.

### Changed
- **Audio Processor refactored into modular effects system:** The monolithic `AudioProcessor.processPcmBufferAligned()` DSP logic has been decomposed into separate effect classes under `src/Audio/effects/` — `VolumeEffect`, `FadeEffect`, `BassEffect`, `TrebleEffect`, `CompressorEffect`, and `NormalizerEffect`. Each class owns its biquad filter state and coefficient computation.
- **Replaced `setEqualizer` with `setNormalize`:** `Processor.run()` result and `FFmpegRunResultExtended` now expose `setNormalize(enabled)` instead of `setEqualizer(bass, treble, compressor)`. Use individual `setBass`, `setTreble`, `setCompressor` methods instead.
- **`AudioEffectController` updated:** Replaced `setEqualizer()` with per-effect setters (`setBass`, `setTreble`, `setCompressor`, `setNormalize`). Updated to set properties directly on `AudioProcessor` (e.g. `audioProcessor.bass = b`).
- **`ThrottleStream` rewritten:** Uses `performance.now()` instead of `Date.now()`, proper pending timer management with cancellation, and a shorter 500ms window for more responsive throttling.
- **Processor cleanup improvements:** `_cleanup()` now kills the FFmpeg child process with `SIGKILL` before nullifying references. `readStderrStream` forwards errors through a new `onError` callback, which `Processor` uses to emit `'error'` and finalize the run.
- **`FluentStream` audio state delegation:** All audio property accessors (`volume`, `bass`, `treble`, `compressor`, `useAudioProcessor`) and chain methods (`setVolume`, `setBass`, etc.) now delegate to `FluentAudioState` instead of managing state directly.

### Fixed
- **`AudioProcessor` bypass detection:** Fade effect active state is now checked via `this.fadeEffect.active` instead of a stale `fadeActive` boolean flag.
- **`fade-end` event emission:** The fade completion event is now emitted once after the loop, rather than inline during `nextVolume()`.

## [0.5.3] – 2026-06-24

### Added
- **Early Input Stream Validation:** Added a strict guard in `Processor.setInputStreams()` that explicitly throws an error if multiple `ReadableStream` inputs are provided. This prevents pipeline corruption and formalizes the cross-runtime limitation of a single standard input (`pipe:0`).

### Changed
- **Output Auto-Drain Lifecycle:** Removed the unconditional `ensureOutputDrained()` call from the default execution path in `Processor.run()`. Auto-draining is now strictly opt-in via `config.autoDrainOutput`, protecting the beginning of the user's output stream from race conditions and premature chunk consumption.
- **Builder Re-run UX:** Enhanced developer feedback when encountering the `isDirty` state in `FluentStream.run()`. Added comprehensive JSDoc documentation and revised the validation error message to explicitly guide users to invoke `.clear()` before reusing the stream instance.

## [0.5.2] – 2026-06-24

### Added
- **Automated FFmpeg Discovery:** Introduced intelligent resolution of the FFmpeg binary path (`resolveFfmpegPath`). It seamlessly falls back across explicit paths, optional npm packages (`ffmpeg-static`, `@ffmpeg-installer/ffmpeg`) using dynamic `createRequire`, and global system binaries across Node.js, Bun, and Deno environments.

### Fixed
- **FluentStream state cleanup:** Automatically clear `this.processorResult` once the underlying execution promise (`result.done`) settles, preventing memory retention and stale tracking states.
- **Test environment stability:** Guarded functional audio effect tests with `it.skipIf(!hasFfmpeg)` to prevent failures in environments or CI pipelines lacking a local FFmpeg installation.

## [0.5.1] – 2026-06-24

### Fixed

- **Processor lifecycle:** added an explicit process state model (`idle`, `running`, `terminating`, `finished`, `failed`, `closed`) for predictable `run()`, `kill()`, `close()`, timeout and error handling
- **Completion handling:** guarded `done` promise settlement so resolve/reject happens exactly once across exit, error and cleanup paths
- **Termination semantics:** separated normal exits, user-initiated `kill()`/`close()`, timeout kills and spawn/process failures
- **Node child process exits:** treat `code === null` as an abnormal process result unless it belongs to an intentional user termination
- **Process errors:** Node runner forwards child process `error` events separately from exit callbacks, preserving errors such as `spawn ffmpeg ENOENT`

## [0.5.0] – 2026-06-24

### Added

- **Multi-runtime support:** automatic FFmpeg runner selection for Node.js, Bun, Deno, and Browser
- **Browser runner:** optional `@ffmpeg/ffmpeg` + `@ffmpeg/core` integration via `BrowserFFmpegRunner`
- **Web Streams API:** `run()` returns `ReadableStream<Uint8Array>`; Node.js streams are adapted internally for input
- **Module layout:** `Fluent/` (API), `Core/` (Processor), `Runner/` (platform runners), `Audio/` (effects), `Types/` (split types)
- **`FFmpegRunner` abstraction:** `spawn`, `resolveBlobUrl`, and lazy `FFmpegManager` for runtime-specific process handling
- **Property accessors:** `volume`, `bass`, `treble`, `compressor`, `useAudioProcessor` on `FluentStream` with live effect updates during playback

### Changed

- **Breaking:** package exports are named — use `import { FluentStream } from "fluent-streamer"` (default export removed from public API)
- **Breaking:** `.run()` is now `async` and returns `Promise<FFmpegRunResultExtended>`
- **`FluentStream`** moved from `Core/` to `Fluent/`; **`AudioProcessor`** moved to `Audio/`
- **`Processor`** refactored to use platform runners and Web Streams throughout the pipeline
- **Types** split into `Types/core.ts`, `Types/audio.ts`, and `Types/index.ts`
- **Tooling:** ESLint/Prettier replaced with oxlint/oxfmt (`oxlintrc.json`)

### Fixed

- Stream input/output handling aligned with cross-runtime Web Streams contract
- Blob URL resolution delegated to the active runner when available

## [0.4.0] — 2026-06-23

### Bug Fixes

- **run():** removed broken `_runInProgress`/`_runQueue` queue mechanism that always threw `isDirty` error on queued calls
- **setHeaders():** no longer mutates `this.args` — only updates `this.headers` (was removing all `-headers` entries including ones belonging to URL inputs)
- **url inputs:** tracked via `inputSources` (not just `args`) — `Processor.getFullArgs()` now handles headers + reconnect opts for URL-type inputs
- **blob/pipe inputs:** removed incorrect else-branch in `getFullArgs()` that was duplicating `-i pipe:0` entries
- **DEFAULT_LOGGER:** truly no-op now (removed hidden `process.emitWarning` + `console` calls)

### Architecture

- **AudioEffectController:** extracted from `Processor.run()` — replaces 6 inline closures with a proper private class
- **stderr listeners:** merged two `process.stderr.on("data", ...)` listeners into one
- **global state removed:** `Processor` no longer has `static logger` — logging is now fully instance-level via `options.logger`
- **type cleanup:** removed duplicate `export interface Processor` from `Types/index.ts` (conflicted with actual `Processor` class)
- **value exports removed:** `ProcessorClass`, `AudioProcessor` no longer re-exported from `Types`

### Code Quality

- **\_ensureFinalOutputDrained:** simplified — replaced complex event-based consumer detection (4 listeners + timer + mutating flag) with a single `setTimeout` + `readableFlowing`/`listeners("data")` check
- **getTimeString():** locale changed from hardcoded `ru-RU` to `en-US` (configurable via argument)
- **AudioProcessor format:** `sampleRate` (default 48000) and `channels` (default 2) are now configurable via `AudioProcessingOptions` instead of hardcoded
- **lint warnings:** fixed 2 `no-useless-fallback-in-spread` warnings (unnecessary `|| {}` fallbacks)
- **tooling:** migrated from ESLint/Prettier to oxlint/oxfmt; build now includes esbuild minification + sourcemaps

## [0.3.1] — 2026-01-25

- Minor fixes and dependency updates

## [0.3.0] — 2025-11-27

- Crossfade audio support via `acrossfade` filter
- Improved stream handling for multi-input scenarios

## [0.2.x] — 2025-10

- AudioProcessor with real-time EQ (bass, treble, compression)
- Fade in/out effects
- Progress tracking via `progress` events
- `enableProgressTracking`, `useAudioProcessor` options
- ThrottleStream for bitrate-limited output
- Various stream management improvements

## [0.1.x] — 2025-10

- Initial FluentStream builder API
- Basic FFmpeg wrapper with fluent chainable interface
- Input/output stream support
- HTTP headers and user-agent configuration
- Complex filter chains
- Blob URL resolution
- TypeScript types and exports
