# Changelog

All notable changes to this project will be documented in this file.

## [0.8.2] – 2026-11-05

### Fixed
- **Automix preparation:** Reject incoming streams that end without a complete PCM frame instead of reporting them as ready. Clean up failed preparation without interrupting the current track or causing the mixer session to fail.

### Added
- **Mixer regression coverage:** Verify that empty incoming audio is rejected while the current track remains playable and that short streams with a complete PCM frame are accepted.
- **Tempo scaling diagnostics:** Add tempo and beat matching metrics with regression tests for scaling, octave ambiguity and one-to-one beat matching.

### Changed
- **Windows test compatibility:** Correct the FFmpeg fixture path and stream validation expectation. Allow more time for two real-FFmpeg Automix tests and handle transition rejection during cleanup.

## [0.8.1] – 2026-11-03

### Fixed
- **Bun asynchronous stdin failures:** Await `FileSink.write()`, `flush()` and `end()` so synchronous and asynchronous pipe errors, including `EPIPE`, reject the corresponding Web Stream operation instead of escaping as unhandled rejections. Reject writes after process exit and avoid ending an already retired stdin.
- **Native runner lifecycle notifications:** Cache and replay exit status to late subscribers in Bun and Deno; make Node, Bun and Deno notification delivery idempotent and reentrant-safe. Forward rejected Bun exit/Deno status promises through `onError`, including late subscriptions, while retaining native Node/Deno stream backpressure and error propagation.
- **Browser/WASM lifecycle and cancellation:** Make completion idempotent and replay exit status to late subscribers; unblock pending stdin waits on kill/abort, cancel pending HTTP fetches, clear buffered input and terminate FFmpeg workers on completion, failure and cancellation. Honor numeric nonzero `ffmpeg.exec()` results and report output-read failures. HTTP-fetch errors no longer include source URLs. The adapter remains batch-based, not a live streaming runtime.

### Added
- **Cross-runtime runner regression coverage:** Add Bun stdin/lifecycle, Deno native-stream/status and browser/WASM lifecycle tests. Native Node tests and real Bun playback/seek/crossfade checks pass; Deno was also checked with a real FFmpeg PCM round-trip and late exit subscription. Browser coverage uses mocked WASM bindings, not an actual browser session.

### Changed
- **Runtime documentation:** Update English and Russian README versions and document the server adapters' stdin/error behavior and the browser's finite-input buffering limitations. Bun mock tests now spy on the existing `Bun.spawn` when run under Bun instead of replacing its non-configurable global.

## [0.8.0] – 2026-11-03

### Added
- **Replayable streaming sources:** Export `ReplayableStreamSource` with `open(signal: AbortSignal): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>` and `ReplayableInput`. Accept factories in `.input()`, live crossfade, prepared Automix and DJ analysis without provider-specific dependencies. Registration is lazy; each decoder or analyzer opens an independent stream with backpressure, without downloading the full file into memory or a temporary file. Existing file, URL and one-shot stream inputs retain their behavior.
- **Factory seek and transition coverage:** Repeated seeks open fresh streams and use output-side `-ss` after `-i pipe:0`, decoding and discarding from the beginning rather than assuming stdin supports range seeking. Factories work as outgoing and incoming mixed-playback sources; activation reuses the prepared decoder. Analysis and transitions can open several independent downloads. Documented an abort-aware async-generator adapter and the performance limitations of reread-based seeking.

### Fixed
- **Factory resource ownership and cancellation:** Give each opening its own abort signal; abort before reader cancellation and release its lock on stop, startup failure, source failure, stdin closure and process exit. Pending openings reject promptly on cancellation, and late streams are disposed without affecting other openings of the same factory. Stopping a mixed session also cancels pending seek/crossfade startup; prepared-transition cancellation retires only its own resources.
- **Backpressured decoder shutdown:** Propagate cancellation through the output pipeline and terminate FFmpeg independently of blocked output cleanup, with bounded escalation for a process stuck flushing stdout. Use Node's native writable Web Stream adapter to handle stdin backpressure and avoid unhandled `EPIPE` events during decoder retirement.
- **Partial audio settings:** Accept `Partial<AudioProcessingOptions>` in `AudioProcessor` and `ProcessorOptions.audioProcessorOptions`, applying defaults for omitted effect settings. Corrected test helper types for typed-array buffers, factory diagnostics and synchronous/asynchronous stop results.

### Changed
- **Faster offline regression tests:** Compare PCM with native byte equality, aggregate per-frame stability extrema instead of constructing matchers in DSP loops, and shorten redundant live-EQ settling windows and fixtures while retaining real FFmpeg coverage and all scenarios. The local full run completed in 19.69 s with 901 passing tests and two expected failures; timings depend on the environment. No test timeouts were increased.

## [0.7.5] – 2026-11-02

### Changed
- **Quieter info level and public logging options:** Export shared `LoggingOptions` (`logger?: Logger`, `verbose?: boolean`) and `LogLevel`. Centralize technical event levels in `LOG_LEVELS`; FFmpeg command/configuration, playback statistics, bitrate, blob validation and live DSP changes now use `debug` instead of `info`. External loggers remain responsible for level filtering.
- **Unified object-logger dispatch:** Processor, FluentStream, audio effects and internal pipeline helpers use a shared logging policy. Custom `Logger` methods receive messages independently of `verbose`, preserving their receiver and metadata; without a logger, only errors are printed unless `verbose: true`. Updated test loggers to the new `playerError`/`child` interface and retained URL redaction. The library does not close externally supplied loggers.

## [0.7.4]  – 2026-11-01

### Fixed
- **Private media URLs in FFmpeg logs:** HTTP(S) URLs are replaced with `[redacted-url]` in verbose command logs, abnormal-exit stderr tails and process-exit errors by default, including signatures embedded in paths. Set `FLUENT_STREAMER_LOG_URLS=1` to explicitly enable full URLs for debugging. Executed arguments and raw diagnostic hooks are unchanged.

## [0.7.3] – 2026-11-01

### Changed
- **Stream HTTP seek cache to disk:** The opt-in cache now uses `hyperttp.stream()` and writes the original compressed bytes directly to a private temporary file with backpressure and the existing `seekCacheMaxBytes` limit. `hcacher` stores only the path after successful complete download; incomplete, oversized, cancelled or failed downloads remove the partial file and retain HTTP seek fallback. This avoids collecting or copying a whole track on the playback event loop. Node and Bun integration tests cover seek, cleanup and failure paths.

## [0.7.2] – 2026-11-01

### Added
- **Opt-in compressed HTTP seek cache:** `seekCache: true` starts a bounded background download of a single HTTP input without delaying initial FFmpeg playback. `hcacher` holds at most one complete compressed file per stream (16 MiB default, configurable with `seekCacheMaxBytes`); a ready entry is written to a private temporary file for repeated local FFmpeg seeks, and cleaned up on session end. Unready, failed and oversized downloads fall back to the original HTTP URL; this does not guarantee instant seeks, eliminate external output buffering, or cache newly crossfaded tracks. Tests cover repeated ordinary and mixed-session seek against a no-Range HTTP server and size-limit fallback. Opting in adds a second full HTTP request and bounded per-stream memory/disk use.

## [0.7.1] – 2026-11-01

### Fixed
- **Prepared Automix cue-zero playback over HTTP:** Do not add `-ss 0` when opening the incoming decoder at cue zero. On HTTP sources that ignore byte-range requests, the unnecessary seek could discard initially probed audio and start the prepared track from later PCM. Nonzero cues still use an explicit seek. Added a real-FFmpeg regression test with a local HTTP server that ignores ranges, delayed consumption of prebuffered audio, and distinct incoming tones to verify the original cue-zero audio survives the seamless handoff without reopening the incoming URL.

## [0.7.0] – 2026-11-01

### Added
- **Opt-in seamless DJ handoff (not a mashup):** `prepareAutomix(url, { transitionMode: 'seamless', outgoingRemainingMs, incomingDurationMs? })` prepares the incoming decoder without running BPM analysis, then hands audio across a bounded ≤350 ms native-speed crossfade near the outgoing tail (1 s source reserve) from incoming cue 0. It rejects tempo matching, `dropHandoff`, explicit drop seeking, and manual overlaps longer than 500 ms. An explicit manually checked cue may be supplied through `transitionOverride` with at most 500 ms overlap. A missed scheduled start rejects instead of moving the decoded cue. The existing long beat-handoff/crossfade modes remain available unchanged; this new mode does not infer downbeats or select an ideal cue automatically. For the selected Hot Wheels 132 s → Zatoichi 72 s pair a **manual** 350 ms preview through the real `PlaybackMixer` is in `.dj-diagnostics/drop-review-20261101/seamless-hot-132-to-zatoichi-72.wav`; max digital-zero run was 27 ms and source-time estimate was within ~15 ms in this local run. That does not establish perceptually seamless vocals or Discord/WebRTC performance.
- **Selected cue verified in the production PCM mixer:** After the listener selected Zatoichi's 72-second candidate, `scripts/render-live-handoff.mjs` now reproduces Hot Wheels 132 s → Zatoichi 72 s using the actual `FluentStream.prepareAutomix()` / `PlaybackMixer` beat-handoff with an **explicit** cue override and the normal returning-tempo filter. This does **not** enable automatic beat/drop matching: both tracks' grid/drop confidence still fails the automatic gates. The rendered 22-second WAV is in ignored `.dj-diagnostics/drop-review-20261101/live-hot-132-to-zatoichi-72.wav`, with JSON statistics: 48 kHz stereo, 6 s overlap, peak 0.1133 and no ≥100 ms digital silence. Source-position estimate at the end differed from the tempo timeline prediction by ~7 ms in this run, not a sample-accurate measurement. With no input gain, the source itself clipped **before** the transition (17 frames at full scale near 1.53 s); the experimental live preview now uses `-af volume=0.1`, matching the cited bot log and preventing this particular clipping. PCM integrity in a local test does not prove musical alignment, live client pacing, or audible quality.
- **Offline transition audition:** `node scripts/render-drop-candidate.mjs outgoing.mp3 incoming.mp3 outgoingAnchorSeconds incomingAnchorSeconds outgoingBpm incomingBpm output.wav` renders a short, opt-in 48 kHz stereo WAV and JSON diagnostics without overwriting existing files. It uses the library's returning-tempo FFmpeg filter (6 s overlap, 4 s tempo return), checks output duration, digital silence and peak level, and leaves the live DJ policy unchanged. Three WAV variants for Hot Wheels 132 s → Zatoichi 37/63/72 s were rendered in the ignored `.dj-diagnostics/drop-review-20261101/` directory for listening. They are deliberately **unranked**: these anchors are not proven musical drops or downbeats, this offline FFmpeg crossfade is not the real-time bass-handoff mixer, and passing PCM checks does not certify a musically good transition.
- **Diagnostic section cues:** `DjAnalysis.structuralCues` reports sustained changes in low-frequency spectral share with time, pre/post proportions and observed onset count. It uses the existing analysis worker and at most 90 seconds of PCM; it does not claim semantic musical drops, override `dropMs`, or feed production Automix. The supplied Hot Wheels excerpt starting at 96 seconds yields a cue candidate at absolute 132 seconds; Zatoichi's first 90 seconds yields candidates including 37, 63, and 72 seconds. These are unverified arrangement changes, not approved handoff positions.
- **Local rhythm corroboration:** `DjAnalysis.localRhythm` compares adjacent holdout-validated local beat fits at both ends of the later holdout and reports only pairs with ≤0.5% BPM difference and ≤1/16-beat extrapolated phase disagreement. Training windows overlap and share an estimated tempo seed; results are `previewOnly` diagnostic evidence, **not** independent confidence, automatic downbeat detection, or permission to bypass existing Automix safety thresholds. Synthetic regular, changed-tempo, sparse and off-phase tests exercise abstention.
- **Opt-in late drop handoff:** `prepareAutomix(nextUrl, { dropHandoff: true, outgoingRemainingMs, incomingDurationMs })` can analyze a separate 90-second window starting in the outgoing track's second half and time an overlap so the first confident outgoing second-half energy rise and first confident incoming first-half rise coincide at the handoff. `DjAnalysis.dropCandidates` exposes chronological energy-rise candidates while the existing `dropMs`/`dropConfidence` continue to describe the strongest rise. Requires confident drops and valid beat grids for both excerpts; otherwise it keeps the existing Automix decision. Windowed `analyzeTrack(source, { startSeconds })` returns window-relative measurements; `planDropHandoff()` accepts its absolute window offset and returns timing advice or null. The extra decoder/worker runs sequentially after normal analysis, adding CPU/network cost; nothing starts automatically. A prepared drop plan rejects if armed after its start rather than silently shifting its decoded cue. Energy rises are only heuristic drop candidates, not validated downbeats, and audible alignment, latency and PCM continuity still depend on the source and consumers.

## [0.6.6] – 2026-10-31

### Fixed
- **Live DSP with large native stdout chunks:** Split raw PCM lazily into blocks of at most 20 ms before `AudioProcessor`, preserving downstream backpressure instead of processing an entire native stdout chunk ahead of playback. This prevents a buffered whole-track chunk from completing DSP early and making later EQ updates ineffective while the consumer is still playing that audio. Tests cover fragmented bytes, cancellation, upstream errors, bounded processing, and measured live EQ response with a large raw chunk. Native raw buffering itself remains runtime-dependent and is not eliminated by the splitter.

## [0.6.5] – 2026-10-31

### Added
- **Local PCM pacing diagnostic:** `node tests/bench-live-pcm.mjs` (also runnable with Bun after `npm run build`) plays a generated local WAV through FFmpeg, live EQ, and a crossfade into a single 20-ms consumer. It reports startup separately from source-read waits, tick lateness, event-loop delay, and mixed-session generation stats. This is a controlled library check, not a measurement of Discord, WebRTC, network, or audible underruns.

### Fixed
- **Short crossfade startup:** Limit incoming warmup to the number of PCM frames actually needed by a sub-20-ms or zero-duration crossfade, instead of always waiting for 20 ms of incoming audio. A stalled incoming source no longer blocks a one-frame switch at outgoing EOF after its first frame arrives. Longer crossfades retain their 20-ms warmup and downstream delivery still depends on the consumer's pacing and available source data.
- **Live EQ across crossfade and mixed seek:** Extend prepared-Automix EQ forwarding to ordinary crossfade and mixed-session seek replacement decoders. Bass, mids, and treble changes made during decoder startup or overlap are no longer lost at handover. Temporary forwarding is removed when the operation settles. Real-FFmpeg regression tests measure PCM RMS changes for all three bands during ordinary playback, mixed playback, and crossfade handover; already-processed PCM still retains its previous EQ until buffers drain.

## [0.6.4] – 2026-10-31

### Fixed
- **Live EQ during prepared Automix:** Bass, mids, and treble updates now reach both the active and prepared incoming decoder while waiting for a transition and throughout its overlap. Incoming startup catches up with settings changed during analysis; cancellation, failure, and handover remove the temporary forwarding. Mixed-result EQ setters use the same path, preventing stale prepared settings from returning after handover. Already-processed PCM retains its prior EQ until downstream buffers drain.

## [0.6.3] – 2026-10-31

### Fixed
- **Transition async overhead:** Ready PCM frames, including prepared warmup and consumed EOF, are read synchronously during crossfade/beat-handoff. Promises are only awaited when an upstream chunk is actually needed; simultaneous decoder waits remain concurrent. Fragmented and contiguous input tests verify byte-identical transition output. This reduces async scheduling overhead without changing envelopes, adding a pacing clock, or guaranteeing downstream underrun-free playback.

## [0.6.2] – 2026-10-31

### Fixed
- **Automix source-time after tempo matching:** Track a piecewise source/output timeline using the same speed steps as the FFmpeg tempo-return commands. Subsequent preparation subtracts elapsed source time, converts absolute source cue schedules back to PCM frames, and maps the outgoing tail reserve through the tempo timeline. The accumulated offset remains accounted for after returning to native speed; seek and native-speed track replacement reset the mapping. This models the configured tempo schedule, not sample-exact FFmpeg filter latency or downstream device playback.

### Added
- **Mixed-session source position:** `streamer.getPlaybackPositionMs()` returns the absolute source position in milliseconds from consumed mixed PCM, including the Automix tempo-return schedule, or `null` outside a mixed session. External players can use this instead of a wall-clock position for subsequent scheduling. This does not measure fan-out delivery or underruns at browser/Discord clients.

## [0.6.0] – 2026-10-27

### Added
- **Automix decision diagnostics:** `PrepareAutomixOptions.onDiagnostic` (also available on `planAutomix`) receives exactly one `AutomixDiagnostic` per planner decision, even when the plan is `null`; preparation failures before planning do not emit a decision. Delivery is independent of `verbose`, and callback exceptions are swallowed. Exported `AutomixDiagnostic` / `AutomixFallbackReason` describe finite scalar analysis snapshots for both outgoing/incoming tracks (missing/non-finite values become `null`, no source URLs), per-track grid issues, timing inputs, `tempoRatio`, `octaveRelated`, and `outcome` (`energy-entry`, `tempo-phrase`, `crossfade`, or `null` for no plan). Fallback/rejection codes are `unreliable-both-grids`, `unreliable-outgoing-grid`, `unreliable-incoming-grid`, `tempo-mismatch`, `insufficient-overlap`, `insufficient-grid-window`, `incoming-duration-limit`, and `invalid-timing`; `fallbackReason` is otherwise `null`. With `verbose: true`, the configured logger receives debug `[tag] Automix decision` with code `FluentStream-automix-decision` and the diagnostic as `detail`; logger exceptions are swallowed too. Conservative safety thresholds are unchanged: unreliable grids/incompatible tempos retain cue-zero fallback with no drop seek, even with `explicitDropMs`. `octaveRelated` is diagnostic only, not tempo correction or automatic seek. Decision diagnostics are separate from `getPlaybackStats()` mixer statistics. Both READMEs include callback logging examples.
- **Prepared automix:** `await streamer.prepareAutomix(nextUrl, { outgoingRemainingMs, incomingDurationMs?, fallbackSeconds: 8, signal? })` analyzes both sources and prebuffers while old audio continues. Sample actual remaining milliseconds at the call and prepare queue entries early. `await prepared.start()` arms a PCM-frame schedule (not a wall-clock timer) and resolves after overlap; keep consuming the same output. Preparation reserves the transition against seek/crossfade/second preparation, snapshots decoder configuration/effects, and does not hold EOF or auto-start there. Cancel an unstarted preparation when the queue changes (abort via signal while pending); handle preparation/start rejection, including stale plans that no longer fit. Later effect setters affect only the active decoder until handover.
- **Public DJ analysis/planning:** Exported `analyzePcm`, `analyzePcmAsync`, `analyzeTrack`, `planAutomix`, and types `DjAnalysis`, `DjAnalysisOptions`, `PcmAnalysisOptions`, `AutomixPlan`, `AutomixPlanOptions`, `PrepareAutomixOptions`, `PreparedAutomix`. Mono Int16 PCM analysis and runtime-selected FFmpeg decoding share one analyzer: first 90 seconds only, at least 8 seconds, confidence heuristics rather than calibrated probabilities. Track analysis supports abort, defaults to a 25-second total deadline covering decoder startup/decoding and worker startup/analysis, and caps 4 kHz mono s16le output at 720,000 bytes (not downloaded bytes); requires the runner's FFmpeg backend and uses analysis runner defaults rather than all playback options. Uncached preparation separately opens/decodes both tracks and opens incoming playback again: additional network/CPU and media-endpoint URL/header exposure, no external analysis service or built-in cache. Callers can supply trusted cached analyses from original source beginnings, not post-seek excerpts.
- **Off-thread CPU analysis:** Public `analyzePcmAsync(samples, sampleRate, { signal?, timeout? })` copies analyzed PCM without detaching caller input and runs the shared analyzer in a dedicated worker. `PcmAnalysisOptions.timeout` defaults to 25,000 ms and includes worker startup; abort/timeout terminates the worker, and each worker is terminated before its job settles. `analyzeTrack` and uncached `prepareAutomix` automatically use workers with no synchronous fallback; worker errors reject. `analyzePcm` remains deliberately synchronous for offline use and blocks the calling/main thread. Node compiled builds resolve `dist/Audio/analysis/DjAnalysisWorker.js` and `DjAnalysisCore.js`; bundlers/deployments must preserve worker/core assets and relative resolution. Direct TypeScript source workers require Node ≥22.18. Bun, Deno, and browser/module Web Worker execution remain unverified, not promised compatibility.
- **Playback stats snapshot:** `streamer.getPlaybackStats()` returns a frozen `PlaybackMixerStats` snapshot for the current mixed session, or `null` outside one. Exposes emitted/pull counts, generation duration totals/maxima, `latePullCount`, fixed-20-ms `deadlineMissCount`, `frameShortageCount`, preparation waits, upstream pending reads, warmup frames, and preparation/cleanup state. Generation timing excludes time between consumer reads; deadline misses/shortages do not establish physical player underruns. Consumer deadlines need a separate clock and downstream telemetry.
- **Responsiveness benchmark:** `./node_modules/.bin/tsc && node scripts/bench-dj-responsiveness.mjs` compares baseline, two synchronous analyses, and two concurrent worker analyses with deterministic seeded 90-second PCM through the real mixer. Reports environment, calibration-sized window, separate fixed-clock 20-ms consumer misses, event-loop delay/utilization, and mixer diagnostics. Async duration includes worker lifecycle/copy/IPC; the startup proxy is not pure startup. This is a short synthetic observation, not worst-case complexity or a performance guarantee, and does not measure FFmpeg/network/device underruns. Both READMEs document reproduction rather than machine-specific timing promises. External bot settings/player are unavailable here; disappearance of audible bot stutters is not verified.
- **Conservative automix plans:** Both tracks need valid 70–180 BPM grids with BPM/phase confidence ≥ 0.65 and tempo ratio ≤ 1.03; detected drops require confidence ≥ 0.7 within the analyzed window. Low confidence/ambiguous rhythm or incompatible tempo intentionally falls back to cue-zero crossfade with no drop seek, even with `explicitDropMs`. Plans use absolute source milliseconds (overlap `seconds` is seconds), up to 16 beats, a 16-second cap, one-second outgoing reserve, and at most a quarter of known incoming duration. For unequal reliable BPMs within the tempo gate, estimated drift is limited to 1/16 of the shorter beat: overlaps prefer four-beat bars, then whole beats if a bar cannot fit. If no grid-aligned overlap fits, these unequal-tempo plans use an ordinary cue-zero crossfade of at most 1 second. Equal-tempo plans retain four-beat groups and the configured fallback if they cannot fit; low-confidence/incompatible-tempo fallback also retains its configured length subject to duration caps and can still overlap percussive material. Beat phase is only an offset, not bar/downbeat detection; the drift budget assumes stable tempo, not measured phase error. There is no pitch/playback-speed adjustment, time stretching, or guaranteed persistent beat sync/drop landing. `prepareAutomix()` automatically enables `bassHandoff: true` with smooth outgoing low-band attenuation to −12 dB, equal-power overlap, and 3 dB midpoint headroom. This is not an automatically perfect mix.
- **Shaped live transitions:** `crossfade(nextUrl, seconds, options)` accepts an absolute incoming `startTime` in seconds, `curve`, `outgoingBassDb`, `bassHandoff`, `bassCutoffHz`, and `headroomDb` through exported `LiveCrossfadeOptions`. Optional `bassHandoff?: boolean` defaults to `false`; manual use: `await streamer.crossfade(url, seconds, { bassHandoff: true, curve: 'equalPower', headroomDb: 3 })`. Independent per-channel outgoing/incoming low-band histories smoothly close outgoing lows and open incoming lows over 35–65% of the fade. The single-pole split has leakage, not a brick-wall cutoff or full frequency exchange: full-range envelopes still overlap, drums/percussive material can still clash, and clean drum separation is not guaranteed. Existing defaults remain linear with no bass attenuation, handoff, or headroom reduction.
- **Midrange equalizer:** Added `MidsEffect`, a broad 1 kHz peaking filter with independent channel states and a user range of `-20` to `20` (up to ±12 dB). Available through `audioProcessorOptions.mids`, the `mids` property, fluent `.setMids()` / `.changeMids()`, and result `.setMids()`.
- **Karaoke effect:** Added `KaraokeEffect`, `audioProcessorOptions.karaoke` (default `false`), `.setKaraoke()`, `.changeKaraoke()`, the `karaoke` accessor, and result `.setKaraoke()` for live updates with `useAudioProcessor: true`. Stereo-preserving mid/side processing attenuates the center over approximately 180 Hz–6 kHz with a nominal depth of -24 dB; overall mid/side energy adapts suppression to avoid fully hard-panned signals. Runtime changes ramp over 50 ms of audio; initial settings apply immediately. Mono is unchanged. This is not vocal isolation: centered instruments can be affected and panned/reverberant vocals can remain.
- **Live crossfade:** Opt in with `enableCrossfade: true` before `run()`, then call `await streamer.crossfade(url, time = 3)` or `result.crossfade?.(url, time)`. Duration is in seconds; `0` switches without a fade. Transitions retain the same output stream and session `done`. Requires one argument-based `.input(file/URL)`, explicit `pcm_s16le`, raw `s16le`, matching sample rate/channels (48 kHz stereo by default), and one stdout output; stream/blob inputs and complex filters are unsupported.
- **Crossfade diagnostics:** With `verbose: true`, lifecycle logs report preparation, mixing, completion, and failure through the configured logger, including transition duration, elapsed time, and `loggerTag`. Crossfade messages omit source URLs, and logger exceptions do not interrupt playback.
- **Live seek:** `await streamer.seek(90)` and `await result.seek?.('00:01:30')` seek to an absolute position in the current track. Positions accept finite non-negative seconds or timestamp strings. Supported for an active run with one replayable file/URL input, stdout output, and no complex filters; stream/blob inputs are unsupported, and non-seekable URL servers may fail. `.seekInput()` remains pre-run configuration.
- **Mixed-session seek:** With `enableCrossfade: true`, seek retains the same public result, output, and session `done`, including after switching tracks. Applies sequential 20 ms fade-out and 20 ms fade-in using audio-frame timing without changing user volume or DSP fade state. Seek rejects during crossfade; crossfade and additional seeks reject while seeking.
- **Ordinary seek lifecycle:** Without mixed playback, seek returns a replacement result/output/`done`; applications must reconnect the consumer and retain the new result. Concurrent seeks and stale-result calls reject. Both seek modes preserve runtime volume, EQ, compressor, karaoke, and normalization settings; neither clears external player queues automatically.
- **Regression tests:** Added coverage for monotonic timing, Node backpressure, EQ response and smoothing, normalization, karaoke, seek, crossfade prebuffering, slow decoder retirement, cancellation, and cleanup failures, including real FFmpeg integration tests.

### Changed
- **Smooth live equalizer updates:** Bass, mids, and treble changes transition over 50 ms of processed audio, including returns to neutral and repeated updates. Initial settings remain immediate. Coefficient smoothing and auxiliary peak activation use audio frames without wall-clock timers or extra audio buffering.
- **Normalizer gain control:** Limited amplification to ×4 (approximately +12 dB), targeting -1 dBFS. Signals at or below -60 dBFS are not amplified and reset accumulated gain. Gain reduction is immediate; recovery uses a 0.5-second time constant based on audio duration. Toggling normalization resets gain history.
- **Breaking — audio channel validation:** The built-in `AudioProcessor` supports only mono (`1`) and stereo (`2`). Other channel counts throw `RangeError` instead of silently processing only the first two channels.
- **Mixed playback consumption:** Auto-drain is disabled. Keep the consumer flowing while awaiting crossfade or mixed seek; backpressure can stall completion. Transition promises cover PCM generation, while session `done` and `stop()` also await decoder cleanup. Request transitions before session completion; there is no automatic track queue or DJ beat matching. Overlapping decoders increase CPU/network use, and network gapless playback is not guaranteed.
- **Documentation:** Updated both READMEs with PCM playback, live effects, crossfade, seek, and prepared-automix queue examples and lifecycle guidance. Bot migration: replace local analyzer/planner imports with public library exports and remove duplicate implementations in the bot project; external bot files are outside this repository. Clarified that the browser/WASM runner buffers input and exposes output after processing, rather than supporting real-time streaming.

### Fixed
- **Realtime mixer overhead:** Ordinary playback now copies contiguous ready PCM blocks instead of awaiting and processing one frame at a time. Transition boundaries still remain frame-accurate, while the non-transition path avoids tens of thousands of unnecessary async operations per second and leaves more event-loop/CPU budget for prepared DJ decoders and downstream fan-out.
- **DJ analysis diagnostics and flow:** Beat-grid confidence now evaluates the already-fitted phase using onset support, expected-beat coverage, and RMS timing residuals instead of shifting phase a second time through a coarse histogram. Tempo confidence separates successful-window agreement from window coverage and uses continuous whole-excerpt period fitting; failed windows no longer silently count as agreement, while broad harmonic candidates do not by themselves invalidate the dominant tempo. Drop detection now runs independently before BPM/phase early returns, so energy transitions remain available on rhythmically ambiguous tracks. Analysis exposes onset count, bass-onset count, tempo-window coverage/agreement, beat coverage, grid error, and downbeat evidence for diagnostics. FFT remains at 512 samples because the current onset timestamp refinement is calibrated to that window; increasing it without retuning timestamps caused measurable regressions.\n
- **Crossfade startup stalls:** Prebuffer approximately 20 ms (at most 1024 frames) of the next source while continuing to output the old source at full gain. Start the fade counter only after the prebuffer is ready or the next source reaches EOF.
- **Decoder cleanup in the audio path:** Retire old decoders in the background instead of awaiting FFmpeg shutdown before publishing ready PCM. Session `done` and `stop()` still await pending cleanup and propagate failures. Intentional mixer cancellation is distinguished from genuine output-pipeline failures.
- **Replacement startup at EOF:** Keep mixed sessions open while a replacement decoder is preparing, rather than closing output prematurely when the old source ends. Exhausted sources and later network stalls may still cause gaps.
- **Throttle startup and pause recovery:** Start pacing from the first audio chunk rather than stream construction. Limit catch-up credit to 5 ms after source/consumer pauses and late timers, preventing startup bursts followed by abrupt pacing changes.
- **PCM output pacing:** Stopped changing output throttle speed based on FFmpeg stderr bitrate. PCM pacing remains determined by sample rate, channel count, and sample size.
- **Input starvation:** Removed the unconditional 32 KB/s input throttle. Input flow follows downstream backpressure instead of a fixed bitrate limit.
- **Node stream backpressure:** Bounded stdout/stderr buffering through native Web Stream adapters. Node input streams pause when the Web Stream queue fills and resume on demand, with cancellation, error, and premature-close handling.
- **Monotonic timing:** Replaced `Date.now()` with `performance.now()` for skip debouncing and elapsed-duration measurements. Wall-clock changes no longer affect these intervals, and the first skip is not blocked immediately after startup.
- **Treble stability:** Scaled filter frequencies below Nyquist at low sample rates, preventing unstable filter state and persistent silence.
- **PCM saturation:** Clamp samples after normalization before conversion to `Int16Array`, preventing integer wraparound.
- **Stderr diagnostics:** Keep the newest messages after the buffer reaches its limit, and preserve detected bitrates without the previous 32–320 kbps clamp.

## [0.5.5] – 2026-08-26

### Changed
- Replaced `eventemitter3` with `hemmiter` (`MiniEmitter`) in `Processor`
- Added typed `ProcessorEvents` map (`progress`, `error`, `end`, `terminated`)
- Exported `MiniEmitter`, `ProcessorEvents` from public API
- `autoDrainOutput` default changed back to `true`

### Fixed
- **Bun:** replaced bare `Bun` global with `globalThis.Bun` to fix TypeScript type errors (`src/Bun/*`)
- **Node:** late subscriber for `exit`/`error` events now receives events via state replay (`src/Runner/runners/node.ts`)
- **Vitest:** deduplicated env variable injection in `vitest.config.ts`

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
