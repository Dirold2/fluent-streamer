#!/usr/bin/env node
// Run after `npm run build`: node tests/bench-live-pcm.mjs
// Local FFmpeg fixture and one 20 ms consumer; no network, Discord, or browser.
// Results describe this process only, not audible underruns in a downstream player.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { FluentStream } from '../dist/index.js';

const RATE = 48000;
const FRAME_BYTES = 3840;
const PERIOD_MS = 20;
const TICKS = 250;
const directory = mkdtempSync(join(tmpdir(), 'fluent-live-pcm-'));
const file = join(directory, 'tone.wav');
const loop = monitorEventLoopDelay({ resolution: 1 });
let result;
let reader;
let transition;
try {
  const generated = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
    '-ar', String(RATE), '-ac', '2', file,
  ], { encoding: 'utf8', timeout: 30000 });
  if (generated.error || generated.status !== 0) {
    throw generated.error ?? new Error(`FFmpeg fixture failed: ${generated.stderr}`);
  }

  const stream = new FluentStream({
    enableCrossfade: true,
    useAudioProcessor: true,
    disableThrottling: true,
    autoDrainOutput: false,
  })
    .input(file)
    .audioCodec('pcm_s16le')
    .outputOptions('-vn', '-f', 's16le', '-ar', String(RATE), '-ac', '2')
    .output(FluentStream.stdout);
  result = await stream.run();
  void result.done.catch(() => {});
  reader = result.output.getReader();
  let chunk = new Uint8Array(0);
  let offset = 0;
  const readWaits = [];
  const tickLateness = [];
  let slowReads = 0;
  let lateTicks = 0;
  const consumeFrame = async () => {
    let remaining = FRAME_BYTES;
    while (remaining > 0) {
      if (offset === chunk.length) {
        const start = performance.now();
        const next = await reader.read();
        const wait = performance.now() - start;
        readWaits.push(wait);
        if (wait > PERIOD_MS) slowReads++;
        if (next.done) throw new Error('PCM source ended before diagnostic completed');
        chunk = next.value;
        offset = 0;
        if (!chunk.length) continue;
      }
      const bytes = Math.min(remaining, chunk.length - offset);
      offset += bytes;
      remaining -= bytes;
    }
  };

  // Measure startup separately: it includes decoder spawn and is not an audible underrun.
  const startupAt = performance.now();
  await consumeFrame();
  const startupMs = performance.now() - startupAt;
  readWaits.length = 0;
  slowReads = 0;
  loop.enable();
  let deadline = performance.now() + PERIOD_MS;
  for (let tick = 1; tick < TICKS; tick++) {
    await sleep(Math.max(0, deadline - performance.now()));
    const now = performance.now();
    const lateness = Math.max(0, now - deadline);
    tickLateness.push(lateness);
    if (lateness > PERIOD_MS) lateTicks++;
    // Never catch up by draining several audio frames at once after a late timer.
    deadline = Math.max(deadline + PERIOD_MS, now + PERIOD_MS);
    await consumeFrame();
    if (tick === 60) stream.setBass(8);
    if (tick === 110) {
      transition = stream.crossfade(file, 0.5);
      void transition.catch(() => {});
    }
  }
  await transition;
  loop.disable();
  const sorted = (items) => [...items].sort((a, b) => a - b);
  const percentile = (items, fraction) => items.length ? sorted(items)[Math.ceil(items.length * fraction) - 1] : 0;
  console.log(JSON.stringify({
    note: 'Local single-consumer PCM generation, not Discord/WebRTC playback',
    framesConsumed: TICKS,
    bytesConsumed: TICKS * FRAME_BYTES,
    startupMs,
    readWaitMs: {
      count: readWaits.length,
      over20ms: slowReads,
      p99: percentile(readWaits, 0.99),
      max: Math.max(0, ...readWaits),
    },
    tickLateMs: {
      over20ms: lateTicks,
      p99: percentile(tickLateness, 0.99),
      max: Math.max(0, ...tickLateness),
    },
    eventLoopDelayMs: { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    mixer: stream.getPlaybackStats(),
  }, null, 2));
} finally {
  loop.disable();
  try {
    if (reader) await reader.cancel().catch(() => {});
    if (result) {
      await result.stop();
      await result.done.catch(() => {});
    }
    await transition?.catch(() => {});
  } finally {
    reader?.releaseLock();
    rmSync(directory, { recursive: true, force: true });
  }
}
