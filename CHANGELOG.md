# Changelog

All notable changes to this project will be documented in this file.

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
