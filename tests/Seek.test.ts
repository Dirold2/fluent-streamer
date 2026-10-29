import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FluentStream } from "../src/index.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const active: FFmpegRunResultExtended[] = [];
afterEach(async () => {
  for (const result of active.splice(0)) await result.stop();
});

function track() {
  return new FluentStream({
    autoDrainOutput: false,
    disableThrottling: true,
    useAudioProcessor: true,
  })
    .input("tests/320.mp3")
    .audioCodec("pcm_s16le")
    .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
    .output("pipe:1");
}
async function collect(result: FFmpegRunResultExtended) {
  const reader = result.output.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  reader.releaseLock();
  await result.done;
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

describe.skipIf(!hasFFmpeg)("live seek", () => {
  it("restarts the same input at an absolute timestamp and returns replacement PCM", async () => {
    const fluent = track();
    const first = await fluent.run();
    active.push(first);
    // A locked but unread output must not deadlock stop/seek under backpressure.
    const oldReader = first.output.getReader();
    const next = await fluent.seek("00:00:00.1");
    active.push(next);
    expect(next.output).not.toBe(first.output);
    await expect(first.done).resolves.toBeUndefined();
    await oldReader.cancel().catch(() => {});
    oldReader.releaseLock();
    const actual = await collect(next);
    const expectedRun = await track().seekInput(0.1).run();
    active.push(expectedRun);
    expect(actual).toEqual(await collect(expectedRun));
    expect(actual.length).toBeGreaterThan(0);
    await expect(first.seek!(0)).rejects.toThrow(/no longer active/);
  }, 15000);

  it("preserves result-side EQ, volume, compressor and normalization", async () => {
    const fluent = track();
    const first = await fluent.run();
    active.push(first);
    first.setVolume!(0.4);
    first.setBass!(8);
    first.setMids!(-6);
    first.setTreble!(4);
    first.setCompressor!(true);
    first.setNormalize!(true);
    const pending = first.seek!(0);
    await expect(fluent.seek(1)).rejects.toThrow(/in progress/);
    const next = await pending;
    active.push(next);
    expect(next.audioProcessor!.volume).toBe(0.4);
    expect(next.audioProcessor!.bass).toBeCloseTo(0.4);
    expect(next.audioProcessor!.mids).toBeCloseTo(-0.3);
    expect(next.audioProcessor!.treble).toBeCloseTo(0.2);
    expect(next.audioProcessor!.compressor).toBe(true);
    expect(next.audioProcessor!.normalize).toBe(true);
    await collect(next);
  }, 15000);

  it("supports backward and repeated seeks without accumulating -ss options", async () => {
    const fluent = track();
    const first = await fluent.run();
    active.push(first);
    const middle = await fluent.seek(0.2);
    active.push(middle);
    const last = await middle.seek!(0.05);
    active.push(last);
    expect(fluent.getArgs().filter((arg) => arg === "-ss")).toHaveLength(1);
    const expected = await track().seekInput(0.05).run();
    active.push(expected);
    expect(await collect(last)).toEqual(await collect(expected));
  }, 15000);

  it("rejects non-replayable inputs without stopping them", async () => {
    const fluent = new FluentStream({ autoDrainOutput: false });
    const first = await track().run();
    active.push(first);
    // Validate the unsupported configuration before any lifecycle side effects.
    const internals = fluent as unknown as { processorResult: FFmpegRunResultExtended };
    internals.processorResult = first;
    fluent.input(new ReadableStream()).output("pipe:1");
    await expect(fluent.seek(0)).rejects.toThrow(/replayable/);
    expect((await collect(first)).length).toBeGreaterThan(0);
  }, 15000);

  it("validates positions before stopping the active run", async () => {
    const fluent = track();
    const first = await fluent.run();
    active.push(first);
    for (const position of [-1, NaN, Infinity, "", "oops", "-1"]) {
      await expect(fluent.seek(position)).rejects.toThrow(/position/);
    }
    expect((await collect(first)).length).toBeGreaterThan(0);
    await expect(fluent.seek(0)).rejects.toThrow(/no active run/);
  }, 15000);
});

it("rejects seek without an active run", async () => {
  await expect(new FluentStream().seek(1)).rejects.toThrow(/no active run/);
});
