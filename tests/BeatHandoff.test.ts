import { describe, expect, it } from "vitest";
import PlaybackMixer, { validateLiveCrossfadeOptions } from "../src/Audio/PlaybackMixer.js";
import type { LiveCrossfadeOptions } from "../src/Types/index.js";

const sampleRate = 48000;
const fadeFrames = 4800;
const totalFrames = fadeFrames + 960;
const beat: LiveCrossfadeOptions = { mode: "beat-handoff" };
const retire = async () => {};

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

// Deliberately split inside samples/stereo frames as well as across output batches.
function source(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  const sizes = [1, 137, 4093, 2048];
  let chunk = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + sizes[chunk++ % sizes.length]!);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      expect(value.byteLength % 2).toBe(0);
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

function tone(hz: number, amplitude = 8000): number[] {
  return Array.from({ length: totalFrames }, (_, frame) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * hz * frame) / sampleRate)),
  );
}

const silence = () => Array<number>(totalFrames).fill(0);

function rms(values: number[], from: number, to: number): number {
  const window = values.slice(Math.round(from * fadeFrames), Math.round(to * fadeFrames));
  return Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length);
}

async function render(
  outgoing: number[],
  incoming: number[],
  options: LiveCrossfadeOptions = beat,
  channels = 1,
  mutate?: () => void,
): Promise<Uint8Array> {
  const mixer = new PlaybackMixer(source(pcm(outgoing)), sampleRate, channels, retire);
  try {
    // Preparation removes warmup-dependent outgoing frames from envelope measurements.
    const prepared = await mixer.prepare(source(pcm(incoming)), retire);
    const transition = mixer.crossfadePrepared(prepared, fadeFrames / sampleRate, options);
    mutate?.();
    const result = await drain(mixer.output);
    await transition;
    await mixer.done;
    expect(result.byteLength).toBe(incoming.length * 2);
    return result;
  } finally {
    await mixer.stop();
  }
}

describe("PlaybackMixer beat-handoff", () => {
  it("accepts the three supported mode values and keeps explicit crossfade byte-identical to default", async () => {
    for (const mode of [undefined, "crossfade", "beat-handoff"] as const)
      expect(() => validateLiveCrossfadeOptions({ mode })).not.toThrow();
    const outgoing = tone(60);
    const incoming = tone(3000);
    expect(await render(outgoing, incoming, { mode: "crossfade" })).toEqual(
      await render(outgoing, incoming, {}),
    );
  });

  it("rejects unsupported modes before acquiring or pulling the incoming reader", async () => {
    const mixer = new PlaybackMixer(source(pcm(silence())), sampleRate, 1, retire);
    try {
      for (const mode of ["", "beat", "BEAT-HANDOFF", null, false, 1, {}]) {
        const options = { mode } as unknown as LiveCrossfadeOptions;
        let pulls = 0;
        const incoming = new ReadableStream<Uint8Array>(
          {
            pull: () => {
              pulls++;
            },
          },
          { highWaterMark: 0 },
        );
        expect(() => validateLiveCrossfadeOptions(options)).toThrow(RangeError);
        await expect(mixer.crossfade(incoming, 0.1, retire, options)).rejects.toThrow(RangeError);
        expect(incoming.locked).toBe(false);
        expect(pulls).toBe(0);
      }
    } finally {
      await mixer.stop();
    }
  });

  it("holds outgoing highs near unity through 75%, then fades them out instead of using the linear envelope", async () => {
    const high = tone(3000);
    const handoff = samples(await render(high, silence()));
    const linear = samples(await render(high, silence(), { mode: "crossfade", curve: "linear" }));
    const reference = rms(high, 0.65, 0.74);
    expect(rms(handoff, 0.65, 0.74) / reference).toBeGreaterThan(0.9);
    expect(rms(handoff, 0.65, 0.74) / rms(linear, 0.65, 0.74)).toBeGreaterThan(2.5);
    expect(rms(handoff, 0.9, 0.98)).toBeLessThan(reference * 0.3);
    expect(handoff[fadeFrames - 1]).toBe(0);
  });

  it("brings incoming highs to unity by 25% and uses p=(frame+1)/frames from the first frame", async () => {
    const high = tone(3000);
    const handoff = samples(await render(silence(), high));
    const linear = samples(await render(silence(), high, { mode: "crossfade", curve: "linear" }));
    expect(rms(handoff, 0.25, 0.34) / rms(high, 0.25, 0.34)).toBeGreaterThan(0.9);
    expect(rms(handoff, 0.25, 0.34) / rms(linear, 0.25, 0.34)).toBeGreaterThan(2.5);
    const impulse = silence();
    impulse[0] = 24000;
    const first = samples(await render(silence(), impulse))[0]!;
    // The existing complementary one-pole split starts with zero low-band state.
    const alpha = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
    expect(
      Math.abs(first - Math.round(24000 * (1 - alpha) * (4 / fadeFrames))),
    ).toBeLessThanOrEqual(1);
    expect(first).toBeGreaterThan(0);
  });

  it("hands low frequencies over between 37.5% and 62.5% with complementary envelopes", async () => {
    const low = tone(60);
    const incoming = samples(await render(silence(), low));
    const outgoing = samples(await render(low, silence()));
    const early = [0.2, 0.35] as const;
    const late = [0.65, 0.8] as const;
    // A one-pole split leaves some 60 Hz in the high band; do not require an LR4 null.
    expect(rms(incoming, ...early) / rms(low, ...early)).toBeLessThan(0.4);
    expect(rms(outgoing, ...early) / rms(low, ...early)).toBeGreaterThan(0.9);
    expect(rms(incoming, ...late) / rms(low, ...late)).toBeGreaterThan(0.9);
    expect(rms(outgoing, ...late) / rms(low, ...late)).toBeLessThan(0.4);
    for (const frame of [1800, 2100, 2400, 2700, 2999]) {
      const p = (frame + 1) / fadeFrames;
      const incomingLowGain = Math.max(0, Math.min(1, (p - 0.375) / 0.25));
      const alpha = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
      let filtered = 0;
      for (let i = 0; i <= frame; i++) filtered += alpha * (low[i]! - filtered);
      const high = low[frame]! - filtered;
      expect(Math.abs(incoming[frame]! - (high + filtered * incomingLowGain))).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(outgoing[frame]! - (high + filtered * (1 - incomingLowGain))),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("reaches unity on the last fade frame and continues incoming PCM byte-identically without silence", async () => {
    const incoming = tone(3000).map((value) => value + 2000);
    const result = await render(tone(60), incoming);
    expect(samples(result)[fadeFrames - 1]).toBe(incoming[fadeFrames - 1]);
    expect(result.slice(fadeFrames * 2)).toEqual(pcm(incoming).slice(fadeFrames * 2));
    expect(rms(samples(result), 1, totalFrames / fadeFrames)).toBeGreaterThan(5000);
  });

  it("keeps stereo filter state independent and produces finite, unclipped, DC-free tone output", async () => {
    const high = tone(3000, 5000);
    const low = tone(60, 5000);
    const outgoing = high.flatMap((value, frame) => [value + low[frame]!, 0]);
    const incoming = high.flatMap((value, frame) => [value - low[frame]!, 0]);
    const output = samples(await render(outgoing, incoming, beat, 2));
    const left = output.filter((_, index) => index % 2 === 0);
    const right = output.filter((_, index) => index % 2 === 1);
    expect(right.every((value) => value === 0)).toBe(true);
    expect(left.every((value) => Number.isFinite(value) && Math.abs(value) < 32767)).toBe(true);
    expect(rms(left, 0.25, 0.75)).toBeGreaterThan(3000);
    // One full 60 Hz cycle (and 50 high-frequency cycles), after the low handoff.
    const steady = left.slice(3000, 3800);
    expect(Math.abs(steady.reduce((sum, value) => sum + value, 0) / steady.length)).toBeLessThan(
      100,
    );
  });

  it("snapshots mode and shaping options when a prepared transition starts", async () => {
    const outgoing = tone(60);
    const incoming = tone(3000);
    const options: LiveCrossfadeOptions = { mode: "beat-handoff", bassCutoffHz: 180 };
    const expected = await render(outgoing, incoming, { ...options });
    const actual = await render(outgoing, incoming, options, 1, () => {
      options.mode = "crossfade";
      options.bassCutoffHz = 1000;
      options.headroomDb = 12;
    });
    expect(actual).toEqual(expected);
  });
});
