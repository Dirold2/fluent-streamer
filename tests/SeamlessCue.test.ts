import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { FluentStream } from "../src/index.js";

const sampleRate = 48000;
const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function wav(incoming: boolean): Buffer {
  const frames = sampleRate * 6;
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const hz = incoming ? (frame < sampleRate ? 1000 : 1600) : 400;
    const sample = Math.round(10000 * Math.sin((2 * Math.PI * hz * frame) / sampleRate));
    bytes.writeInt16LE(sample, 44 + frame * 4);
    bytes.writeInt16LE(sample, 46 + frame * 4);
  }
  return bytes;
}

function amplitude(pcm: Uint8Array, hz: number): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = pcm.byteLength / 4;
  let sin = 0;
  let cos = 0;
  for (let frame = 0; frame < frames; frame++) {
    const phase = (2 * Math.PI * hz * frame) / sampleRate;
    const value = view.getInt16(frame * 4, true);
    sin += value * Math.sin(phase);
    cos += value * Math.cos(phase);
  }
  return (2 * Math.hypot(sin, cos)) / frames;
}

it.skipIf(!hasFFmpeg)(
  "preserves HTTP cue-zero PCM after a stalled seamless prebuffer",
  async () => {
    const outgoing = wav(false);
    const incoming = wav(true);
    const requests: string[] = [];
    // A replayable HTTP URL need not implement byte ranges. Reconnect must not
    // silently replace the cue with later PCM after an unnecessary zero seek.
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const bytes = req.url === "/incoming.wav" ? incoming : outgoing;
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": bytes.length });
      res.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const fluent = new FluentStream({
      enableCrossfade: true,
      autoDrainOutput: false,
      disableThrottling: true,
    })
      .inputOptions(
        "-rw_timeout",
        "10000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_on_http_error",
        "5xx",
        "-reconnect_delay_max",
        "5",
        "-probesize",
        "1024k",
        "-analyzeduration",
        "1000000",
        "-i",
        `${base}/outgoing.wav`,
      )
      .audioCodec("pcm_s16le")
      .outputOptions("-vn", "-f", "s16le", "-ar", "48000", "-ac", "2")
      .output(FluentStream.stdout);
    let result: Awaited<ReturnType<FluentStream["run"]>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      result = await fluent.run();
      void result.done.catch(() => {});
      reader = result.output.getReader();
      await reader.read();
      const position = fluent.getPlaybackPositionMs()!;
      const prepared = await fluent.prepareAutomix(`${base}/incoming.wav`, {
        transitionMode: "seamless",
        outgoingRemainingMs: 6000 - position,
        incomingDurationMs: 6000,
      });
      expect(prepared.plan.cueMs).toBe(0);
      expect(prepared.plan.startMs - position).toBeGreaterThan(4000);
      // Exceed the auto-drain timer while both decoders are backpressured.
      await delay(150);
      const startFrame = Math.round((prepared.plan.startMs / 1000) * sampleRate);
      const fadeFrames = Math.round(prepared.plan.seconds * sampleRate);
      const samples: number[] = [];
      let frame = Math.round((fluent.getPlaybackPositionMs()! / 1000) * sampleRate);
      let completed = false;
      const transition = prepared.start().then(() => {
        completed = true;
      });
      void transition.catch(() => {});
      while (frame < startFrame + sampleRate * 1.5) {
        const item = await reader.read();
        expect(item.done).toBe(false);
        const view = new DataView(
          item.value!.buffer,
          item.value!.byteOffset,
          item.value!.byteLength,
        );
        for (let offset = 0; offset < item.value!.byteLength; offset += 4, frame++) {
          if (frame >= startFrame) samples.push(view.getInt16(offset, true));
        }
      }
      await transition;
      expect(completed).toBe(true);
      const window = (from: number, to: number) => {
        const pcm = Buffer.alloc((to - from) * 4);
        for (let i = from; i < to; i++) {
          pcm.writeInt16LE(samples[i]!, (i - from) * 4);
          pcm.writeInt16LE(samples[i]!, (i - from) * 4 + 2);
        }
        return pcm;
      };
      const mixed = window(4800, 9600);
      expect(amplitude(mixed, 400)).toBeGreaterThan(1000);
      expect(amplitude(mixed, 1000)).toBeGreaterThan(1000);
      expect(amplitude(mixed, 1600)).toBeLessThan(30);
      const cue = window(fadeFrames + 4800, 43200);
      expect(amplitude(cue, 1000)).toBeGreaterThan(9000);
      expect(amplitude(cue, 1600)).toBeLessThan(30);
      const later = window(55200, 67200);
      expect(amplitude(later, 1600)).toBeGreaterThan(9000);
      expect(amplitude(later, 1000)).toBeLessThan(30);
      expect(requests.filter((url) => url === "/incoming.wav")).toHaveLength(1);
    } finally {
      await reader?.cancel().catch(() => {});
      await result?.stop();
      await result?.done.catch(() => {});
      reader?.releaseLock();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);
