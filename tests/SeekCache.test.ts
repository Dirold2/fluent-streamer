import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { FluentStream } from "../src/index.js";
import { SeekSourceCache } from "../src/Fluent/SeekSourceCache.js";
import type { FFmpegRunResultExtended } from "../src/Types/index.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

async function scenario(mixed: boolean, maxBytes: number) {
  const mp3 = await readFile("tests/320.mp3");
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    // No Range support: without a cache every seek must reopen this URL.
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": mp3.length });
    res.end(mp3);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const stream = new FluentStream({
    seekCache: true,
    seekCacheMaxBytes: maxBytes,
    enableCrossfade: mixed,
    autoDrainOutput: false,
    disableThrottling: true,
  });
  const url = `http://127.0.0.1:${port}/audio.mp3`;
  if (mixed) stream.inputOptions("-rw_timeout", "10000000", "-reconnect", "1", "-i", url);
  else stream.input(url);
  stream
    .audioCodec("pcm_s16le")
    .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
    .output("pipe:1");
  let first: FFmpegRunResultExtended | undefined;
  let latest: FFmpegRunResultExtended | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function mixedSeek(result: FFmpegRunResultExtended, position: number) {
    const pending = result.seek!(position);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 1000 && !settled; i++) {
      if ((await reader!.read()).done) break;
    }
    return pending;
  }
  try {
    first = await stream.run();
    void first.done.catch(() => {});
    reader = first.output.getReader();
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    // Wait for the *background* download, never for playback to consume the track.
    for (let i = 0; i < 200 && stream.getSeekCacheStatus() === "loading"; i++) {
      await delay(10);
    }
    if (maxBytes >= mp3.length) {
      expect(stream.getSeekCacheStatus()).toBe("ready");
    } else {
      expect(stream.getSeekCacheStatus()).toBe("miss");
    }
    const countBefore = requests;
    latest = mixed ? await mixedSeek(first, 0.2) : await first.seek!(0.2);
    void latest.done.catch(() => {});
    if (!mixed) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      reader = latest.output.getReader();
    } else {
      expect(latest.output).toBe(first.output);
    }
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    expect(requests).toBe(countBefore + (maxBytes >= mp3.length ? 0 : 1));
    const second = mixed ? await mixedSeek(latest, 0.1) : await latest.seek!(0.1);
    if (!mixed) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      reader = second.output.getReader();
    }
    latest = second;
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    expect(requests).toBe(countBefore + (maxBytes >= mp3.length ? 0 : 2));
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await latest?.stop().catch(() => {});
    await first?.stop().catch(() => {});
    await latest?.done.catch(() => {});
    await first?.done.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("does not block seek while download is pending; removes private file on dispose", async () => {
  const bytes = Buffer.from("compressed source bytes");
  let finish!: () => void;
  let requested!: () => void;
  const seen = new Promise<void>((resolve) => { requested = resolve; });
  const server = createServer((_req, response) => {
    response.writeHead(200, { "Content-Length": bytes.length });
    finish = () => response.end(bytes);
    requested();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const cache = new SeekSourceCache(`http://127.0.0.1:${port}/audio`, {}, 1024);
  try {
    cache.start();
    await seen;
    expect(cache.status()).toBe("loading");
    expect(await cache.localPath()).toBeUndefined();
    finish();
    for (let i = 0; i < 200 && cache.status() === "loading"; i++) await delay(10);
    expect(cache.status()).toBe("ready");
    const path = await cache.localPath();
    expect(await readFile(path!)).toEqual(bytes);
    await cache.dispose();
    await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    finish?.();
    await cache.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.skipIf(!hasFFmpeg)("caches compressed HTTP input for ordinary repeated seek", async () => {
  await scenario(false, 1024 * 1024);
}, 15000);

it.skipIf(!hasFFmpeg)("keeps mixed PCM output stable when seeking cached HTTP input", async () => {
  await scenario(true, 1024 * 1024);
}, 15000);

it.skipIf(!hasFFmpeg)("falls back to HTTP on a cache size-limit miss", async () => {
  await scenario(false, 1024);
}, 15000);
