import { describe, expect, it, vi } from "vitest";
import PlaybackMixer from "../src/Audio/PlaybackMixer.js";
import type { LiveCrossfadeOptions } from "../src/Types/index.js";

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function source(samples: number[], splits: number[] = []): ReadableStream<Uint8Array> {
  const bytes = pcm(samples);
  let offset = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const length = splits.shift() ?? bytes.length;
        controller.enqueue(bytes.slice(offset, offset + length));
        offset = Math.min(bytes.length, offset + length);
      },
    },
    { highWaterMark: 0 },
  );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const samples: number[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return samples;
      expect(value.byteLength % 2).toBe(0);
      const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
      for (let offset = 0; offset < value.byteLength; offset += 2)
        samples.push(view.getInt16(offset, true));
    }
  } finally {
    reader.releaseLock();
  }
}

const retire = () => vi.fn(async () => {});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// A scheduler checkpoint, not a timer: gates remain closed throughout these turns.
async function checkpoint() {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

function observe(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  return settled;
}

function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const requested = deferred();
  const cancel = vi.fn();
  const pull = vi.fn(() => requested.resolve());
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull,
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, controller, requested: requested.promise, pull, cancel };
}

function pending() {
  const cancel = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, cancel, error: (error: unknown) => controller.error(error) };
}

describe("PlaybackMixer", () => {
  describe("diagnostics", () => {
    function clock() {
      let now = 0;
      const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
      return {
        advance: (ms: number) => {
          now += ms;
        },
        restore: () => spy.mockRestore(),
      };
    }

    it("returns frozen session snapshots and counts enqueued stereo frames, not samples", async () => {
      const time = clock();
      try {
        const mixer = new PlaybackMixer(
          source([1, 2, 3, 4, 5, 6], [1, 1, 1, 1]),
          48000,
          2,
          retire(),
        );
        const initial = mixer.stats;
        expect(Object.isFrozen(initial)).toBe(true);
        expect(initial.emittedFrames).toBe(0);
        expect(await drain(mixer.output)).toEqual([1, 2, 3, 4, 5, 6]);
        await mixer.done;
        expect(mixer.stats).toMatchObject({
          emittedFrames: 3,
          frameShortageCount: 0,
          deadlineMissCount: 0,
          latePullCount: 0,
          pcmWaitMs: 0,
          maxPullMs: 0,
          maxPcmWaitMs: 0,
          preparationWaitCount: 0,
          preparationWaitMs: 0,
          pendingReadCount: 0,
          prebufferedFrames: 0,
          preparing: false,
          cleanupPending: false,
        });
        expect(mixer.stats.pullCount).toBeGreaterThan(0);
        expect(initial.emittedFrames).toBe(0);
      } finally {
        time.restore();
      }
    });

    it("measures delayed first demand but excludes consumer think time and immediate small reads", async () => {
      const time = clock();
      const input = controlled();
      const mixer = new PlaybackMixer(input.stream, 48000, 1, retire());
      try {
        const reader = mixer.output.getReader();
        const first = reader.read();
        await input.requested;
        expect(mixer.stats.pendingReadCount).toBe(1);
        time.advance(25);
        input.controller.enqueue(pcm([10]));
        await first;
        await checkpoint();
        expect(mixer.stats).toMatchObject({
          emittedFrames: 1,
          pullCount: 1,
          deadlineMissCount: 1,
          latePullCount: 1,
          frameShortageCount: 1,
          pcmWaitMs: 25,
          maxPcmWaitMs: 25,
          maxPullMs: 25,
          pendingReadCount: 0,
        });
        time.advance(10000);
        input.controller.enqueue(pcm([20]));
        await reader.read();
        await checkpoint();
        expect(mixer.stats).toMatchObject({
          emittedFrames: 2,
          pullCount: 2,
          deadlineMissCount: 1,
          frameShortageCount: 1,
          pcmWaitMs: 25,
          maxPullMs: 25,
        });
      } finally {
        await mixer.stop();
        time.restore();
      }
    });

    it.each([20, 21, 22])(
      "uses a strict 20 ms deadline and batch duration for lateness (%i ms)",
      async (ms) => {
        const time = clock();
        const input = controlled();
        const mixer = new PlaybackMixer(input.stream, 48000, 1, retire());
        try {
          const read = mixer.output.getReader().read();
          await input.requested;
          time.advance(ms);
          input.controller.enqueue(pcm(Array(1024).fill(1)));
          await read;
          await checkpoint();
          expect(mixer.stats).toMatchObject({
            emittedFrames: 1024,
            deadlineMissCount: ms > 20 ? 1 : 0,
            latePullCount: ms > 1024 / 48 ? 1 : 0,
            frameShortageCount: ms > 20 ? 1 : 0,
            maxPullMs: ms,
          });
        } finally {
          await mixer.stop();
          time.restore();
        }
      },
    );

    it("tracks EOF hold waits only during generation, including cancellation cleanup", async () => {
      const time = clock();
      const cleanup = deferred();
      const mixer = new PlaybackMixer(source([]), 48000, 1, () => cleanup.promise);
      try {
        mixer.hold();
        const read = mixer.output.getReader().read();
        await checkpoint();
        expect(mixer.stats.preparationWaitCount).toBe(1);
        time.advance(35);
        const stopped = mixer.stop();
        await read;
        await checkpoint();
        expect(mixer.stats).toMatchObject({
          emittedFrames: 0,
          preparationWaitCount: 1,
          preparationWaitMs: 35,
          pcmWaitMs: 35,
          deadlineMissCount: 1,
          latePullCount: 1,
          preparing: false,
          cleanupPending: true,
          pendingReadCount: 0,
        });
        cleanup.resolve();
        await stopped;
        await mixer.done;
        expect(mixer.stats.cleanupPending).toBe(false);
      } finally {
        cleanup.resolve();
        await mixer.stop();
        time.restore();
      }
    });

    it("counts warmup waits only after outgoing EOF and exposes background reads/prebuffer", async () => {
      const time = clock();
      const next = controlled();
      const mixer = new PlaybackMixer(source([100]), 48000, 1, retire());
      try {
        const fade = mixer.crossfade(next.stream, 1 / 48000, retire());
        await next.requested;
        time.advance(1000); // Background preparation is not a generation gap.
        expect(mixer.stats).toMatchObject({
          pendingReadCount: 1,
          preparing: true,
          preparationWaitCount: 0,
          pcmWaitMs: 0,
        });
        const reader = mixer.output.getReader();
        await reader.read();
        await checkpoint();
        expect(mixer.stats.preparationWaitCount).toBe(0);
        const waiting = reader.read();
        await checkpoint();
        expect(mixer.stats.preparationWaitCount).toBe(1);
        time.advance(30);
        next.controller.enqueue(pcm(Array(960).fill(200)));
        await waiting;
        await fade;
        await checkpoint();
        expect(mixer.stats).toMatchObject({
          emittedFrames: 2,
          preparationWaitCount: 1,
          preparationWaitMs: 30,
          pcmWaitMs: 30,
          deadlineMissCount: 1,
          frameShortageCount: 0,
          pendingReadCount: 0,
          prebufferedFrames: 959,
          preparing: false,
        });
      } finally {
        await mixer.stop();
        time.restore();
      }
      expect(mixer.stats.prebufferedFrames).toBe(0);
    });

    it("finalizes failed pulls without counting truncated PCM as emitted frames", async () => {
      const time = clock();
      const mixer = new PlaybackMixer(source([1, 2, 3]), 48000, 2, retire());
      try {
        const reader = mixer.output.getReader();
        await reader.read();
        await expect(reader.read()).rejects.toThrow("Truncated PCM16 audio frame");
        await expect(mixer.done).rejects.toThrow("Truncated PCM16 audio frame");
        expect(mixer.stats).toMatchObject({
          emittedFrames: 1,
          pullCount: 2,
          pendingReadCount: 0,
          cleanupPending: false,
        });
      } finally {
        time.restore();
      }
    });

    it.each(["cancel", "error", "eof"] as const)(
      "finalizes a pending read on %s",
      async (ending) => {
        const time = clock();
        const input = controlled();
        const mixer = new PlaybackMixer(input.stream, 48000, 1, retire());
        try {
          const read = mixer.output.getReader().read();
          const observed = read.catch(() => undefined);
          await input.requested;
          time.advance(40);
          if (ending === "cancel") await mixer.stop();
          else if (ending === "error") input.controller.error(new Error("decoder failed"));
          else input.controller.close();
          await observed;
          await mixer.done.catch(() => {});
          await checkpoint();
          expect(mixer.stats).toMatchObject({
            emittedFrames: 0,
            pullCount: 1,
            pcmWaitMs: 40,
            maxPullMs: 40,
            deadlineMissCount: 1,
            latePullCount: 1,
            frameShortageCount: 1,
            pendingReadCount: 0,
            cleanupPending: false,
          });
        } finally {
          await mixer.stop().catch(() => {});
          time.restore();
        }
      },
    );
  });
  it("preserves signed PCM and stereo frames across arbitrary byte chunks", async () => {
    const samples = [-32768, 32767, -123, 456, 0, -1];
    const retired = retire();
    const input = source(samples, [0, 1, 2, 1, 3, 1]);
    const mixer = new PlaybackMixer(input, 48000, 2, retired);
    expect(await drain(mixer.output)).toEqual(samples);
    await mixer.done;
    expect(retired).toHaveBeenCalledTimes(1);
    expect(input.locked).toBe(false);
  });

  it("linearly fades by audio frames, keeps stereo gains aligned and output stable", async () => {
    const oldRetired = retire();
    const nextRetired = retire();
    const mixer = new PlaybackMixer(
      source([1000, -1000, 1000, -1000, 1000, -1000, 1000, -1000]),
      4,
      2,
      oldRetired,
    );
    const output = mixer.output;
    const fade = mixer.crossfade(
      source([0, 2000, 0, 2000, 0, 2000, 0, 2000, 123, -456], [1, 2, 4]),
      1,
      nextRetired,
    );
    let completed = false;
    void fade.then(() => {
      completed = true;
    });
    await checkpoint();
    expect(completed).toBe(false);
    expect(await drain(output)).toEqual([750, -250, 500, 500, 250, 1250, 0, 2000, 123, -456]);
    await fade;
    await mixer.done;
    expect(mixer.output).toBe(output);
    expect(oldRetired).toHaveBeenCalledTimes(1);
    expect(nextRetired).toHaveBeenCalledTimes(1);
  });

  describe("prepared scheduling", () => {
    it.each([{ splits: [] }, { splits: [1, 3, 1, 2, 5, 1, 1] }])(
      "starts on the exact source frame independently of chunks %j",
      async ({ splits }) => {
        const mixer = new PlaybackMixer(source(Array(20).fill(1000), [...splits]), 10, 1, retire());
        expect(mixer.sourceFrame).toBe(0);
        const next = source([2000, 3000, 4000, 5000], [...splits]);
        const token = await mixer.prepare(next, retire());
        expect(mixer.sourceFrame).toBe(0);
        const schedule = { startFrame: 3, beatPeriodFrames: 4 };
        const fade = mixer.crossfadePrepared(token, 0.2, {}, schedule);
        schedule.startFrame = 99;
        expect(await drain(mixer.output)).toEqual([1000, 1000, 1000, 1500, 3000, 4000, 5000]);
        await fade;
        expect(mixer.sourceFrame).toBe(4);
        await mixer.done;
      },
    );

    it("prepares without switching and aligns a late request to the next PCM beat", async () => {
      const old = controlled();
      const next = controlled();
      const mixer = new PlaybackMixer(old.stream, 10, 1, retire());
      const preparing = mixer.prepare(next.stream, retire());
      await next.requested;
      const reader = mixer.output.getReader();
      const first = reader.read();
      old.controller.enqueue(pcm(Array(6).fill(1000)));
      expect((await first).value).toEqual(pcm(Array(6).fill(1000)));
      expect(mixer.sourceFrame).toBe(6);
      next.controller.enqueue(pcm([2000, 3000, 4000]));
      const token = await preparing;
      expect(mixer.sourceFrame).toBe(6);
      const fade = mixer.crossfadePrepared(token, 0.2, {}, { startFrame: 3, beatPeriodFrames: 4 });
      const second = reader.read();
      old.controller.enqueue(pcm(Array(8).fill(1000)));
      expect((await second).value).toEqual(pcm([1000, 1500, 3000]));
      await fade;
      expect(mixer.sourceFrame).toBe(2);
      await reader.cancel();
      await mixer.done;
    });

    it("keeps preparation bounded, discards once, and rejects stale or foreign tokens", async () => {
      const old = source([100, 200]);
      const next = source(Array(100).fill(900));
      const retired = retire();
      const mixer = new PlaybackMixer(old, 1000, 1, retire());
      const token = await mixer.prepare(next, retired);
      const extra = source([1]);
      await expect(mixer.prepare(extra, retire())).rejects.toThrow("already active");
      expect(extra.locked).toBe(false);
      await expect(mixer.crossfade(extra, 1, retire())).rejects.toThrow();
      expect(extra.locked).toBe(false);
      const other = new PlaybackMixer(source([1]), 1000, 1, retire());
      await expect(other.crossfadePrepared(token, 0)).rejects.toThrow();
      await mixer.discardPrepared(token);
      expect(next.locked).toBe(false);
      expect(retired).toHaveBeenCalledTimes(1);
      await expect(mixer.discardPrepared(token)).rejects.toThrow();
      await expect(mixer.crossfadePrepared(token, 0)).rejects.toThrow();
      expect(await drain(mixer.output)).toEqual([100, 200]);
      expect(mixer.sourceFrame).toBe(2);
      await mixer.done;
      await other.stop();
    });

    it.each(["stop", "cancel", "EOF"])(
      "cleans up an unused prepared input on %s",
      async (ending) => {
        const retired = retire();
        const next = source([900, 800]);
        const mixer = new PlaybackMixer(source([100]), 10, 1, retire());
        await mixer.prepare(next, retired);
        if (ending === "stop") await mixer.stop();
        else if (ending === "cancel") await mixer.output.cancel();
        else expect(await drain(mixer.output)).toEqual([100]);
        await mixer.done;
        expect(retired).toHaveBeenCalledTimes(1);
        expect(next.locked).toBe(false);
      },
    );

    it("interrupts pending preparation on stop", async () => {
      const next = controlled();
      const retired = retire();
      const mixer = new PlaybackMixer(source([100]), 10, 1, retire());
      const preparing = mixer.prepare(next.stream, retired);
      const rejected = expect(preparing).rejects.toThrow("stopped");
      await next.requested;
      await mixer.stop();
      await rejected;
      await mixer.done;
      expect(next.cancel).toHaveBeenCalledTimes(1);
      expect(retired).toHaveBeenCalledTimes(1);
      expect(next.stream.locked).toBe(false);
    });

    it("cleans up failed preparation without replacing the outgoing input", async () => {
      const next = source([1], [1]);
      const retired = retire();
      // Stereo requires four bytes per PCM frame.
      const mixer = new PlaybackMixer(source([100, 200]), 10, 2, retire());
      await expect(mixer.prepare(next, retired)).rejects.toThrow("Truncated PCM16");
      expect(retired).toHaveBeenCalledTimes(1);
      expect(next.locked).toBe(false);
      expect(await drain(mixer.output)).toEqual([100, 200]);
      expect(mixer.sourceFrame).toBe(1);
      // Failed warmup remains owned so session completion reports its failure.
      await expect(mixer.done).rejects.toThrow("Truncated PCM16");
    });

    it("publishes PCM then fails output, transition and done when EOF precedes the schedule", async () => {
      const retirement = deferred();
      const oldRetired = vi.fn(() => retirement.promise);
      const nextRetired = retire();
      const old = controlled();
      const next = source([900]);
      const mixer = new PlaybackMixer(old.stream, 10, 1, oldRetired);
      const token = await mixer.prepare(next, nextRetired);
      const fade = mixer.crossfadePrepared(token, 0.2, {}, { startFrame: 10 });
      const rejected = expect(fade).rejects.toThrow("ended before scheduled");
      const doneRejected = expect(mixer.done).rejects.toThrow("ended before scheduled");
      const doneSettled = observe(mixer.done);
      const reader = mixer.output.getReader();
      const reading = reader.read();
      // Make EOF known within the same pull that generates the outgoing PCM.
      old.controller.enqueue(pcm([100, 200]));
      old.controller.close();
      expect((await reading).value).toEqual(pcm([100, 200]));
      await expect(reader.read()).rejects.toThrow("ended before scheduled");
      await rejected;
      expect(mixer.sourceFrame).toBe(2);
      const stopping = mixer.stop();
      const stopped = observe(stopping);
      await checkpoint();
      expect(doneSettled).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      retirement.resolve();
      await stopping;
      await doneRejected;
      expect(old.stream.locked).toBe(false);
      expect(next.locked).toBe(false);
      await mixer.stop();
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      reader.releaseLock();
    });

    it("switches a zero-duration scheduled fade without consuming an incoming frame", async () => {
      const mixer = new PlaybackMixer(source([100, 200, 300]), 10, 1, retire());
      const token = await mixer.prepare(source([900, 800]), retire());
      const fade = mixer.crossfadePrepared(token, 0, {}, { startFrame: 2 });
      expect(await drain(mixer.output)).toEqual([100, 200, 900, 800]);
      await fade;
      await mixer.done;
      expect(mixer.sourceFrame).toBe(2);
    });

    it("tracks serial seek position on the incoming timeline, excluding EOF padding", async () => {
      const mixer = new PlaybackMixer(source([100]), 10, 1, retire());
      const seek = mixer.seek(source([900, 800, 700]), 0.2, retire());
      const reader = mixer.output.getReader();
      expect((await reader.read()).value).toEqual(pcm([50]));
      expect(mixer.sourceFrame).toBe(1);
      expect((await reader.read()).value).toEqual(pcm([0]));
      expect(mixer.sourceFrame).toBe(0);
      expect((await reader.read()).value).toEqual(pcm([0, 800]));
      await seek;
      expect(mixer.sourceFrame).toBe(2);
      expect((await reader.read()).value).toEqual(pcm([700]));
      expect(mixer.sourceFrame).toBe(3);
      await reader.cancel();
    });
  });

  describe("seek", () => {
    it("serially fades stereo to exact zero then starts next frame zero at zero", async () => {
      const oldRetired = retire();
      const nextRetired = retire();
      const old = source(Array(12).fill([1200, -2400]).flat(), [1, 3, 5]);
      const next = source([900, -1800, 300, -600, 600, -1200, 1200, -2400, 77, -154], [1, 2, 5]);
      const mixer = new PlaybackMixer(old, 4, 2, oldRetired);
      const output = mixer.output;
      const seek = mixer.seek(next, 1, nextRetired);
      expect(await drain(output)).toEqual([
        900, -1800, 600, -1200, 300, -600, 0, 0, 0, 0, 100, -200, 400, -800, 1200, -2400, 77, -154,
      ]);
      await seek;
      await mixer.done;
      expect(mixer.output).toBe(output);
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      expect(old.locked).toBe(false);
      expect(next.locked).toBe(false);
    });

    it("uses two default 20 ms phases with monotonic gains and no extra buffer", async () => {
      const mixer = new PlaybackMixer(source(Array(2000).fill(1900)), 1000, 1, retire());
      const seek = mixer.seek(source(Array(23).fill(1900)), undefined, retire());
      const samples = await drain(mixer.output);
      await seek;
      expect(samples).toHaveLength(43);
      expect(samples.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => 1805 - i * 95));
      expect(samples.slice(20, 40)).toEqual(Array.from({ length: 20 }, (_, i) => i * 100));
      expect(samples.slice(40)).toEqual([1900, 1900, 1900]);
    });

    it("preserves seek envelopes without waiting for asynchronous old retirement", async () => {
      let release!: () => void;
      const retirement = new Promise<void>((resolve) => {
        release = resolve;
      });
      const oldRetired = vi.fn(() => retirement);
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        expect(oldRetired).toHaveBeenCalledTimes(1);
        controller.enqueue(pcm([100, 200, 300, 400]));
      });
      const next = new ReadableStream({ pull }, { highWaterMark: 0 });
      const mixer = new PlaybackMixer(source([400, 400, 400, 400]), 4, 1, oldRetired);
      const seek = mixer.seek(next, 1, retire());
      const completed = vi.fn();
      void seek.then(completed);
      const reader = mixer.output.getReader();
      const reading = reader.read();
      expect((await reading).value).toEqual(pcm([300, 200, 100, 0]));
      await checkpoint();
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
      expect((await reader.read()).value).toEqual(pcm([0, 67, 200, 400]));
      await seek;
      expect(completed).toHaveBeenCalledTimes(1);
      const done = observe(mixer.done);
      const stopping = reader.cancel();
      const stopped = observe(stopping);
      await checkpoint();
      expect(done).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      release();
      await stopping;
      await mixer.done;
    });

    it.each(["old", "next", "both"])("pads early %s EOF for the full phases", async (ended) => {
      const mixer = new PlaybackMixer(
        source(ended === "next" ? [400, 400, 400, 400] : [400]),
        4,
        1,
        retire(),
      );
      const seek = mixer.seek(
        source(ended === "old" ? [900, 300, 600, 900] : [900, 300]),
        1,
        retire(),
      );
      expect(await drain(mixer.output)).toEqual([
        ...(ended === "next" ? [300, 200, 100, 0] : [300, 0, 0, 0]),
        ...(ended === "old" ? [0, 100, 400, 900] : [0, 100, 0, 0]),
      ]);
      await seek;
      await mixer.done;
    });

    it.each([0, 0.01])(
      "switches instantly when the frame count rounds to zero (%s)",
      async (seconds) => {
        const retired = retire();
        const mixer = new PlaybackMixer(source([999]), 4, 1, retired);
        const seek = mixer.seek(source([123, -456]), seconds, retire());
        expect(await drain(mixer.output)).toEqual([123, -456]);
        await seek;
        expect(retired).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps next frame zero silent for a one-frame fade", async () => {
      const mixer = new PlaybackMixer(source([999]), 1, 1, retire());
      const seek = mixer.seek(source([123, 456]), 1, retire());
      expect(await drain(mixer.output)).toEqual([0, 0, 456]);
      await seek;
    });

    it.each(["seek", "crossfade"] as const)(
      "rejects either transition while %s is active",
      async (active) => {
        const mixer = new PlaybackMixer(source([100, 100]), 2, 1, retire());
        const transition = mixer[active](source([200, 200]), 1, retire());
        const rejected = source([300]);
        const retired = retire();
        await expect(mixer.seek(rejected, 1, retired)).rejects.toThrow("already active");
        await expect(mixer.crossfade(rejected, 1, retired)).rejects.toThrow("already active");
        expect(rejected.locked).toBe(false);
        expect(retired).not.toHaveBeenCalled();
        await drain(mixer.output);
        await transition;
      },
    );

    it.each(["out", "in", "retiring"])(
      "stops during %s without leaking inputs or settling done early",
      async (phase) => {
        const old = pending();
        const next = pending();
        let release!: () => void;
        const retirement = new Promise<void>((resolve) => {
          release = resolve;
        });
        const oldRetired = vi.fn(() => (phase === "retiring" ? retirement : Promise.resolve()));
        const nextRetired = retire();
        const initial = phase === "out" ? old.stream : source([100, 100]);
        const mixer = new PlaybackMixer(initial, 2, 1, oldRetired);
        const seek = mixer.seek(next.stream, 1, nextRetired);
        const reader = mixer.output.getReader();
        let reading = reader.read();
        if (phase === "in") {
          expect((await reading).value).toEqual(pcm([50, 0]));
          reading = reader.read();
        }
        if (phase === "retiring") {
          expect((await reading).value).toEqual(pcm([50, 0]));
          await checkpoint();
          expect(oldRetired).toHaveBeenCalledTimes(1);
          reading = reader.read();
        }
        const reason = new Error("seek stopped");
        const rejected = expect(seek).rejects.toBe(reason);
        const done = vi.fn();
        void mixer.done.then(done);
        const stopped = mixer.stop(reason);
        if (phase === "retiring") {
          await Promise.resolve();
          expect(done).not.toHaveBeenCalled();
          release();
        }
        await stopped;
        await rejected;
        expect((await reading).done).toBe(true);
        await mixer.done;
        await mixer.stop();
        expect(oldRetired).toHaveBeenCalledTimes(1);
        expect(nextRetired).toHaveBeenCalledTimes(1);
        expect(next.cancel).toHaveBeenCalledTimes(1);
        expect(initial.locked).toBe(false);
        expect(next.stream.locked).toBe(false);
      },
    );

    it.each(["cancel", "output"])("cancels a seek through %s", async (method) => {
      const old = pending();
      const next = pending();
      const retired = retire();
      const mixer = new PlaybackMixer(old.stream, 4, 1, retired);
      const seek = mixer.seek(next.stream, 1, retired);
      const reader = mixer.output.getReader();
      const reading = reader.read();
      const reason = new Error("cancelled");
      const rejected = expect(seek).rejects.toBe(reason);
      if (method === "cancel") await mixer.cancel(reason);
      else await reader.cancel(reason);
      await rejected;
      expect((await reading).done).toBe(true);
      await mixer.done;
      expect(retired).toHaveBeenCalledTimes(2);
      expect(old.stream.locked).toBe(false);
      expect(next.stream.locked).toBe(false);
    });

    it("propagates retirement failure and cleans up next", async () => {
      const error = new Error("retirement failed");
      const nextRetired = retire();
      const mixer = new PlaybackMixer(source([100, 100]), 2, 1, async () => {
        throw error;
      });
      const seek = mixer.seek(source([200, 200]), 1, nextRetired);
      expect(await drain(mixer.output)).toEqual([50, 0, 0, 200]);
      await seek;
      await expect(mixer.done).rejects.toBe(error);
      expect(nextRetired).toHaveBeenCalledTimes(1);
    });

    it("bounds output chunks across long phases and permits a subsequent crossfade", async () => {
      const mixer = new PlaybackMixer(source(Array(2050).fill(2050)), 2050, 1, retire());
      const seek = mixer.seek(source(Array(2052).fill(2049)), 1, retire());
      const reader = mixer.output.getReader();
      const lengths: number[] = [];
      for (let phase = 0; phase < 2; phase++) {
        for (const frames of [1024, 1024, 2]) {
          const { value } = await reader.read();
          expect(value?.byteLength).toBe(frames * 2);
          lengths.push(value!.byteLength / 2);
        }
      }
      await seek;
      expect(lengths.reduce((sum, frames) => sum + frames, 0)).toBe(4100);
      const fade = mixer.crossfade(source([123]), 0, retire());
      await checkpoint();
      expect((await reader.read()).value).toEqual(pcm([123]));
      await fade;
      expect((await reader.read()).done).toBe(true);
      await mixer.done;
    });

    it("starts a seek requested while the old read is pending without consuming next early", async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const old = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
        },
        { highWaterMark: 0 },
      );
      const mixer = new PlaybackMixer(old, 2, 1, retire());
      const reader = mixer.output.getReader();
      const reading = reader.read();
      const pull = vi.fn((output: ReadableStreamDefaultController<Uint8Array>) =>
        output.enqueue(pcm([900, 600])),
      );
      const seek = mixer.seek(new ReadableStream({ pull }, { highWaterMark: 0 }), 1, retire());
      controller.enqueue(pcm([400, 400]));
      expect((await reading).value).toEqual(pcm([200, 0]));
      expect(pull).not.toHaveBeenCalled();
      expect((await reader.read()).value).toEqual(pcm([0, 600]));
      await seek;
      await reader.cancel();
    });

    it.each(["out", "in"])(
      "propagates a source failure during fade-%s and cleans up",
      async (phase) => {
        const failing = pending();
        const oldRetired = retire();
        const nextRetired = retire();
        const mixer = new PlaybackMixer(
          phase === "out" ? failing.stream : source([100, 100]),
          2,
          1,
          oldRetired,
        );
        const next = phase === "in" ? failing.stream : source([200, 200]);
        const seek = mixer.seek(next, 1, nextRetired);
        const reader = mixer.output.getReader();
        if (phase === "in") expect((await reader.read()).value).toEqual(pcm([50, 0]));
        const error = new Error("seek source failed");
        const rejected = expect(seek).rejects.toBe(error);
        const reading = expect(reader.read()).rejects.toBe(error);
        failing.error(error);
        await Promise.all([rejected, reading]);
        await expect(mixer.done).rejects.toBe(error);
        expect(oldRetired).toHaveBeenCalledTimes(1);
        expect(nextRetired).toHaveBeenCalledTimes(1);
        expect(failing.stream.locked).toBe(false);
        expect(next.locked).toBe(false);
      },
    );

    it("validates durations and stopped state without owning rejected inputs", async () => {
      const mixer = new PlaybackMixer(source([]), 4, 1, retire());
      const next = source([100]);
      for (const seconds of [-1, NaN, Infinity, Number.MAX_VALUE]) {
        await expect(mixer.seek(next, seconds, retire())).rejects.toThrow("duration");
        expect(next.locked).toBe(false);
      }
      await mixer.stop();
      await expect(mixer.seek(next, 1, retire())).rejects.toThrow("stopped");
      expect(next.locked).toBe(false);
    });
  });

  it("keeps old reads unscaled during deferred startup and starts the fade clock only when ready", async () => {
    const old = controlled();
    const next = controlled();
    const mixer = new PlaybackMixer(old.stream, 100, 1, retire());
    const fade = mixer.crossfade(next.stream, 0.04, retire());
    const completed = observe(fade);
    await next.requested;
    const reader = mixer.output.getReader();
    // Neither a missing first frame nor an incomplete two-frame prebuffer may stall old PCM.
    old.controller.enqueue(pcm([1000, 1000, 1000]));
    expect((await reader.read()).value).toEqual(pcm([1000, 1000, 1000]));
    next.controller.enqueue(pcm([2000]));
    await checkpoint();
    old.controller.enqueue(pcm([1000, 1000]));
    expect((await reader.read()).value).toEqual(pcm([1000, 1000]));
    expect(completed).not.toHaveBeenCalled();
    next.controller.enqueue(pcm([2000, 2000, 2000, 333]));
    await checkpoint();
    old.controller.enqueue(pcm([1000, 1000, 1000, 1000]));
    expect((await reader.read()).value).toEqual(pcm([1250, 1500, 1750, 2000]));
    await fade;
    expect((await reader.read()).value).toEqual(pcm([333]));
    await reader.cancel();
    await mixer.done;
    expect(old.cancel).toHaveBeenCalledTimes(1);
    expect(next.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1000, 20],
    [48000, 960],
    [96000, 1024],
  ])(
    "prefetches exactly the bounded stereo byte budget at %s Hz (%s frames), without output demand",
    async (sampleRate, frames) => {
      const buffered = deferred();
      let bytes = 0;
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        bytes += 4;
        controller.enqueue(pcm([2000, -2000]));
        if (bytes === frames * 4) buffered.resolve();
      });
      const old = controlled();
      const next = new ReadableStream({ pull }, { highWaterMark: 0 });
      const mixer = new PlaybackMixer(old.stream, sampleRate, 2, retire());
      const fade = mixer.crossfade(next, 2 / sampleRate, retire());
      await buffered.promise;
      await checkpoint();
      expect(bytes).toBe(frames * 4);
      expect(pull).toHaveBeenCalledTimes(frames);
      expect(old.pull).not.toHaveBeenCalled();
      const reader = mixer.output.getReader();
      old.controller.enqueue(pcm([1000, -1000, 1000, -1000]));
      expect((await reader.read()).value).toEqual(pcm([1500, -1500, 2000, -2000]));
      await fade;
      // Reading the two fade frames used buffered PCM, not further upstream demand.
      expect(bytes).toBe(frames * 4);
      await reader.cancel();
      await mixer.done;
      expect(next.locked).toBe(false);
    },
  );

  it("assembles partial stereo chunks in prebuffer without losing bytes or channel alignment", async () => {
    const next = controlled();
    const mixer = new PlaybackMixer(source([1000, -1000, 1000, -1000]), 100, 2, retire());
    const fade = mixer.crossfade(next.stream, 0.02, retire());
    await next.requested;
    const bytes = pcm([2000, -2000, 3000, -3000, 123, -456]);
    for (const byte of bytes) next.controller.enqueue(Uint8Array.of(byte));
    next.controller.close();
    await checkpoint();
    const reader = mixer.output.getReader();
    expect((await reader.read()).value).toEqual(pcm([1500, -1500, 3000, -3000]));
    await fade;
    expect((await reader.read()).value).toEqual(pcm([123, -456]));
    expect((await reader.read()).done).toBe(true);
    await mixer.done;
    expect(next.stream.locked).toBe(false);
  });

  it.each(["stop", "output"] as const)(
    "cancels an incomplete prebuffer through %s, waiting for cancellation and retirement",
    async (method) => {
      const cancellation = deferred();
      const cancelling = deferred();
      const retirement = deferred();
      const retiring = deferred();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const requested = deferred();
      const cancel = vi.fn(() => {
        cancelling.resolve();
        return cancellation.promise;
      });
      const next = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
          },
          pull() {
            requested.resolve();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const old = controlled();
      const oldRetired = retire();
      const nextRetired = vi.fn(() => {
        retiring.resolve();
        return retirement.promise;
      });
      const mixer = new PlaybackMixer(old.stream, 100, 1, oldRetired);
      const fade = mixer.crossfade(next, 1, nextRetired);
      await requested.promise;
      controller.enqueue(pcm([200]));
      await checkpoint();
      const reader = mixer.output.getReader();
      const reading = reader.read();
      const reason = new Error("prebuffer cancelled");
      const rejected = expect(fade).rejects.toBe(reason);
      const done = observe(mixer.done);
      const stopping = method === "stop" ? mixer.stop(reason) : reader.cancel(reason);
      const stopped = observe(stopping);
      await cancelling.promise;
      expect((await reading).done).toBe(true);
      await rejected;
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(nextRetired).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      cancellation.resolve();
      await retiring.promise;
      expect(done).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      retirement.resolve();
      await Promise.all([stopping, mixer.done]);
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      expect(old.stream.locked).toBe(false);
      expect(next.locked).toBe(false);
    },
  );

  it("does not amplify correlated full-scale signals", async () => {
    const mixer = new PlaybackMixer(source([32767, -32768, 32767, -32768]), 4, 1, retire());
    const fade = mixer.crossfade(source([32767, -32768, 32767, -32768]), 1, retire());
    expect(await drain(mixer.output)).toEqual([32767, -32768, 32767, -32768]);
    await fade;
  });

  it.each([0, 0.01])(
    "supports an immediate switch for a duration rounding to zero (%s)",
    async (seconds) => {
      const oldRetired = retire();
      const mixer = new PlaybackMixer(source([999]), 4, 1, oldRetired);
      const fade = mixer.crossfade(source([123, -123]), seconds, retire());
      expect(await drain(mixer.output)).toEqual([123, -123]);
      await fade;
      expect(oldRetired).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["old", "next", "both"])(
    "pads early %s EOF with silence until the fade completes",
    async (ended) => {
      const mixer = new PlaybackMixer(
        source(ended === "next" ? [100, 100, 100, 100] : []),
        4,
        1,
        retire(),
      );
      const fade = mixer.crossfade(
        source(ended === "old" ? [200, 200, 200, 200] : []),
        1,
        retire(),
      );
      expect(await drain(mixer.output)).toEqual(
        ended === "old" ? [50, 100, 150, 200] : ended === "next" ? [75, 50, 25, 0] : [0, 0, 0, 0],
      );
      await fade;
    },
  );

  it("rejects concurrent fades without taking ownership of the rejected stream", async () => {
    const mixer = new PlaybackMixer(source([10, 10]), 2, 1, retire());
    const fade = mixer.crossfade(source([20, 20]), 1, retire());
    const extra = source([30]);
    const extraRetired = retire();
    await expect(mixer.crossfade(extra, 1, extraRetired)).rejects.toThrow("already active");
    expect(extra.locked).toBe(false);
    expect(extraRetired).not.toHaveBeenCalled();
    await drain(mixer.output);
    await fade;
  });

  it("bounds demand and allows successive transitions without replacing output", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
      controller.enqueue(pcm(Array(8192).fill(100))),
    );
    const mixer = new PlaybackMixer(
      new ReadableStream({ pull }, { highWaterMark: 0 }),
      4,
      1,
      retire(),
    );
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    const reader = mixer.output.getReader();
    expect((await reader.read()).value?.byteLength).toBe(2048);
    expect(pull).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(pull).toHaveBeenCalledTimes(1);
    const first = mixer.crossfade(source([200, 200, 200, 200, 200, 200, 200, 200]), 1, retire());
    expect((await reader.read()).value?.byteLength).toBe(8);
    await first;
    const second = mixer.crossfade(source([300, 300, 300, 300]), 1, retire());
    expect((await reader.read()).value?.byteLength).toBe(8);
    await second;
    await reader.cancel();
  });

  it.each(["stop", "cancel", "output"])(
    "%s interrupts pending reads, retires both inputs once and rejects the fade",
    async (method) => {
      const old = pending();
      const next = pending();
      const oldRetired = retire();
      const nextRetired = retire();
      const mixer = new PlaybackMixer(old.stream, 4, 1, oldRetired);
      const fade = mixer.crossfade(next.stream, 1, nextRetired);
      const reason = new Error("cancelled");
      const rejected = expect(fade).rejects.toBe(reason);
      const reader = mixer.output.getReader();
      const reading = reader.read();
      await Promise.resolve();
      if (method === "output") await reader.cancel(reason);
      else if (method === "cancel") await mixer.cancel(reason);
      else await mixer.stop(reason);
      expect((await reading).done).toBe(true);
      await rejected;
      await mixer.stop();
      expect(old.cancel).toHaveBeenCalledTimes(1);
      expect(next.cancel).toHaveBeenCalledTimes(1);
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      expect(old.stream.locked).toBe(false);
      expect(next.stream.locked).toBe(false);
    },
  );

  it("propagates source failure to output and fade while cleaning both inputs", async () => {
    const old = pending();
    const next = pending();
    const retired = retire();
    const mixer = new PlaybackMixer(old.stream, 4, 1, retired);
    const fade = mixer.crossfade(next.stream, 1, retired);
    const error = new Error("source failed");
    const rejected = expect(fade).rejects.toBe(error);
    const reading = expect(mixer.output.getReader().read()).rejects.toBe(error);
    old.error(error);
    await Promise.all([rejected, reading]);
    await expect(mixer.stop()).rejects.toBe(error);
    expect(retired).toHaveBeenCalledTimes(2);
    expect(next.cancel).toHaveBeenCalledTimes(1);
  });

  it("emits short live chunks without waiting for another upstream chunk", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
      },
      { highWaterMark: 0 },
    );
    const mixer = new PlaybackMixer(input, 48000, 1, retire());
    const reader = mixer.output.getReader();
    controller.enqueue(pcm([42]));
    expect((await reader.read()).value).toEqual(pcm([42]));
    await mixer.stop();
  });

  it("propagates next-source failure even while the old source is stalled", async () => {
    const old = pending();
    const next = pending();
    const mixer = new PlaybackMixer(old.stream, 4, 1, retire());
    const fade = mixer.crossfade(next.stream, 1, retire());
    const error = new Error("next failed");
    const rejected = expect(fade).rejects.toBe(error);
    const reading = expect(mixer.output.getReader().read()).rejects.toBe(error);
    next.error(error);
    await Promise.all([reading, rejected]);
    await expect(mixer.stop()).rejects.toBe(error);
    expect(old.cancel).toHaveBeenCalledTimes(1);
  });

  it("can stop repeatedly after natural EOF", async () => {
    const retired = retire();
    const mixer = new PlaybackMixer(source([1]), 1, 1, retired);
    expect(await drain(mixer.output)).toEqual([1]);
    await mixer.stop();
    await mixer.stop();
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated frames instead of silently dropping bytes", async () => {
    const retired = retire();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const mixer = new PlaybackMixer(stream, 4, 2, retired);
    await expect(drain(mixer.output)).rejects.toThrow("Truncated PCM16");
    await mixer.stop();
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"] as const)(
    "publishes final fade and new PCM before retirement; EOF, done and stop respect cleanup (%s)",
    async (outcome) => {
      const cleanup = deferred();
      const entered = deferred();
      const error = new Error("old retirement failed");
      const oldRetired = vi.fn(() => {
        entered.resolve();
        return cleanup.promise;
      });
      const nextRetired = retire();
      const old = source([100, 100]);
      const next = source([200, 200, 321, -123]);
      const mixer = new PlaybackMixer(old, 2, 1, oldRetired);
      const done = observe(mixer.done);
      const fade = mixer.crossfade(next, 1, nextRetired);
      await checkpoint();
      const reader = mixer.output.getReader();
      expect((await reader.read()).value).toEqual(pcm([150, 200]));
      await fade;
      await entered.promise;
      expect((await reader.read()).value).toEqual(pcm([321, -123]));
      expect((await reader.read()).done).toBe(true);
      const stopping = mixer.stop();
      const stopped = observe(stopping);
      await checkpoint();
      expect(done).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      expect(oldRetired).toHaveBeenCalledTimes(1);
      expect(nextRetired).toHaveBeenCalledTimes(1);
      if (outcome === "reject") {
        const failedDone = expect(mixer.done).rejects.toBe(error);
        const failedStop = expect(stopping).rejects.toBe(error);
        cleanup.reject(error);
        await Promise.all([failedDone, failedStop]);
        await expect(mixer.stop()).rejects.toBe(error);
      } else {
        cleanup.resolve();
        await Promise.all([stopping, mixer.done]);
        await mixer.stop();
      }
      expect(old.locked).toBe(false);
      expect(next.locked).toBe(false);
      reader.releaseLock();
    },
  );

  it("propagates retirement failure and still retires the next input", async () => {
    const error = new Error("retirement failed");
    const nextRetired = retire();
    const mixer = new PlaybackMixer(source([100]), 1, 1, async () => {
      throw error;
    });
    const fade = mixer.crossfade(source([200]), 1, nextRetired);
    await checkpoint();
    expect(await drain(mixer.output)).toEqual([200]);
    await fade;
    await expect(mixer.done).rejects.toBe(error);
    await expect(mixer.stop()).rejects.toBe(error);
    expect(nextRetired).toHaveBeenCalledTimes(1);
  });

  it("attempts all cleanup even when cancel and retirement fail", async () => {
    const error = new Error("cancel failed");
    const retired = vi.fn(async () => {
      throw new Error("retire failed");
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        throw error;
      },
    });
    const mixer = new PlaybackMixer(stream, 1, 1, retired);
    const nextRetired = retire();
    const fade = mixer.crossfade(source([10]), 1, nextRetired);
    const rejected = expect(fade).rejects.toThrow("stopped");
    await expect(mixer.stop()).rejects.toBe(error);
    await rejected;
    expect(retired).toHaveBeenCalledTimes(1);
    expect(nextRetired).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  describe("hold", () => {
    function controlled() {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const pull = vi.fn();
      const stream = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull,
        },
        { highWaterMark: 0 },
      );
      return { stream, pull, close: () => controller.close() };
    }

    it("keeps pending read EOF and done open until a replacement is registered and released", async () => {
      const input = controlled();
      const oldRetired = retire();
      const nextRetired = retire();
      const mixer = new PlaybackMixer(input.stream, 1, 1, oldRetired);
      const reader = mixer.output.getReader();
      const reading = reader.read();
      const readSettled = vi.fn();
      const doneSettled = vi.fn();
      void reading.then(readSettled);
      void mixer.done.then(doneSettled);
      await checkpoint();
      expect(input.pull).toHaveBeenCalledTimes(1);

      const release = mixer.hold();
      input.close();
      // Let EOF reach the mixer before registering the replacement.
      await checkpoint();
      expect(readSettled).not.toHaveBeenCalled();
      expect(doneSettled).not.toHaveBeenCalled();
      expect(oldRetired).not.toHaveBeenCalled();

      const replacement = source([200, -300]);
      const fade = mixer.crossfade(replacement, 0, nextRetired);
      release();
      await expect(reading).resolves.toEqual({ value: pcm([200, -300]), done: false });
      await expect(fade).resolves.toBeUndefined();
      expect(doneSettled).not.toHaveBeenCalled();
      expect(oldRetired).toHaveBeenCalledTimes(1);
      await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
      await expect(mixer.done).resolves.toBeUndefined();
      expect(nextRetired).toHaveBeenCalledTimes(1);
      expect(input.stream.locked).toBe(false);
      expect(replacement.locked).toBe(false);
      reader.releaseLock();
    });

    it("closes naturally when released at EOF without a replacement", async () => {
      const retired = retire();
      const mixer = new PlaybackMixer(source([]), 1, 1, retired);
      const release = mixer.hold();
      const reader = mixer.output.getReader();
      const reading = reader.read();
      const readSettled = vi.fn();
      const doneSettled = vi.fn();
      void reading.then(readSettled);
      void mixer.done.then(doneSettled);
      await checkpoint();
      expect(readSettled).not.toHaveBeenCalled();
      expect(doneSettled).not.toHaveBeenCalled();
      expect(retired).not.toHaveBeenCalled();

      release();
      await expect(reading).resolves.toEqual({ value: undefined, done: true });
      await expect(mixer.done).resolves.toBeUndefined();
      expect(retired).toHaveBeenCalledTimes(1);
      reader.releaseLock();
    });

    it.each(["pending input", "EOF"])(
      "stop resolves reads and done while held at %s, and release remains idempotent",
      async (state) => {
        const input = controlled();
        const retired = retire();
        const mixer = new PlaybackMixer(input.stream, 1, 1, retired);
        const release = mixer.hold();
        const reader = mixer.output.getReader();
        const reading = reader.read();
        await checkpoint();
        expect(input.pull).toHaveBeenCalledTimes(1);
        if (state === "EOF") input.close();
        await checkpoint();

        await expect(mixer.stop(new Error("intentional stop while held"))).resolves.toBeUndefined();
        await expect(reading).resolves.toEqual({ value: undefined, done: true });
        await expect(mixer.done).resolves.toBeUndefined();
        expect(() => {
          release();
          release();
        }).not.toThrow();
        await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
        await mixer.stop();
        expect(retired).toHaveBeenCalledTimes(1);
        expect(input.stream.locked).toBe(false);
        reader.releaseLock();
      },
    );
  });

  describe("done", () => {
    it("stays pending across transitions and resolves only at session EOF", async () => {
      const mixer = new PlaybackMixer(source([100]), 1, 1, retire());
      const done = mixer.done;
      let settled = false;
      void done.then(() => {
        settled = true;
      });
      const fade = mixer.crossfade(source([200, 300]), 1, retire());
      const reader = mixer.output.getReader();
      await reader.read();
      await fade;
      expect(settled).toBe(false);
      expect(mixer.done).toBe(done);
      while (!(await reader.read()).done) {}
      await expect(done).resolves.toBeUndefined();
      await mixer.stop(new Error("late stop"));
      await expect(done).resolves.toBeUndefined();
    });

    it.each(["eof", "stop", "cancel", "output"])(
      "waits for retirement on %s and ignores intentional cancellation reasons",
      async (method) => {
        let release!: () => void;
        const retiring = new Promise<void>((resolve) => {
          release = resolve;
        });
        const retired = vi.fn(() => retiring);
        const mixer = new PlaybackMixer(source([]), 1, 1, retired);
        let settled = false;
        void mixer.done.then(() => {
          settled = true;
        });
        const reason = new Error("intentional cancellation");
        const completion =
          method === "eof"
            ? drain(mixer.output)
            : method === "output"
              ? mixer.output.cancel(reason)
              : method === "cancel"
                ? mixer.cancel(reason)
                : mixer.stop(reason);
        await checkpoint();
        expect(retired).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        release();
        await completion;
        await expect(mixer.done).resolves.toBeUndefined();
        await mixer.stop();
        expect(retired).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects source failure only after all cleanup, preserving the original error", async () => {
      const input = pending();
      const error = new Error("source failed");
      let release!: () => void;
      const retiring = new Promise<void>((resolve) => {
        release = resolve;
      });
      const retired = vi.fn(() => retiring);
      const mixer = new PlaybackMixer(input.stream, 1, 1, retired);
      let settled = false;
      void mixer.done.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const reading = expect(mixer.output.getReader().read()).rejects.toBe(error);
      input.error(error);
      await reading;
      await checkpoint();
      expect(retired).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      release();
      await expect(mixer.done).rejects.toBe(error);
      await expect(mixer.stop()).rejects.toBe(error);
      await expect(mixer.done).rejects.toBe(error);
    });

    it("rejects a PCM processing error even when cleanup succeeds", async () => {
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
      const mixer = new PlaybackMixer(input, 1, 1, retire());
      await expect(drain(mixer.output)).rejects.toThrow("Truncated PCM16");
      await expect(mixer.done).rejects.toThrow("Truncated PCM16");
      await mixer.stop();
      await expect(mixer.done).rejects.toThrow("Truncated PCM16");
    });

    it.each(["eof", "stop", "cancel", "output"])(
      "rejects cleanup failure on %s",
      async (method) => {
        const error = new Error("retirement failed");
        const mixer = new PlaybackMixer(source([]), 1, 1, async () => {
          throw error;
        });
        const completion =
          method === "eof"
            ? drain(mixer.output)
            : method === "output"
              ? mixer.output.cancel()
              : method === "cancel"
                ? mixer.cancel()
                : mixer.stop();
        if (method === "eof") await expect(completion).resolves.toEqual([]);
        else await expect(completion).rejects.toBe(error);
        await expect(mixer.done).rejects.toBe(error);
        await expect(mixer.stop()).rejects.toBe(error);
      },
    );

    it("rejects cancellation failure without an unhandled done rejection", async () => {
      const error = new Error("cancel failed");
      const mixer = new PlaybackMixer(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw error;
          },
        }),
        1,
        1,
        retire(),
      );
      await expect(mixer.stop()).rejects.toBe(error);
      // Observe done late; its internal catch must already handle the rejection.
      await checkpoint();
      await expect(mixer.done).rejects.toBe(error);
    });
  });

  it("validates configuration, durations, and stopped state", async () => {
    expect(() => new PlaybackMixer(source([]), 0, 1, retire())).toThrow(RangeError);
    expect(() => new PlaybackMixer(source([]), Infinity, 1, retire())).toThrow(RangeError);
    expect(() => new PlaybackMixer(source([]), 1, 1.5, retire())).toThrow(RangeError);
    const mixer = new PlaybackMixer(source([]), 1, 1, retire());
    for (const seconds of [-1, NaN, Infinity, Number.MAX_VALUE]) {
      const next = source([]);
      await expect(mixer.crossfade(next, seconds, retire())).rejects.toThrow(RangeError);
      expect(next.locked).toBe(false);
    }
    await mixer.stop();
    await expect(mixer.crossfade(source([]), 1, retire())).rejects.toThrow("stopped");
  });
});

describe("opt-in mixtape shaping", () => {
  it("uses equal-power gains and returns to unscaled incoming PCM", async () => {
    const mixer = new PlaybackMixer(source([1000, 1000, 1000, 1000]), 4, 1, retire());
    const fade = mixer.crossfade(source([2000, 2000, 2000, 2000, 2345]), 1, retire(), {
      curve: "equalPower",
    });
    // Complete warmup before consuming the outgoing timeline.
    await checkpoint();
    const samples = await drain(mixer.output);
    await fade;
    expect(samples).toEqual(
      [1, 2, 3, 4]
        .map((i) =>
          Math.round(
            1000 * Math.cos(((i / 4) * Math.PI) / 2) + 2000 * Math.sin(((i / 4) * Math.PI) / 2),
          ),
        )
        .concat(2345),
    );
    await mixer.done;
  });

  it("protects correlated full-scale overlap with a channel-linked peak guard", async () => {
    const samples = Array.from({ length: 8 }, (_, i) => (i % 2 ? 16000 : 32000));
    const mixer = new PlaybackMixer(source(samples), 4, 2, retire());
    const fade = mixer.crossfade(source(samples), 1, retire(), { curve: "equalPower" });
    await checkpoint();
    const output = await drain(mixer.output);
    await fade;
    expect(output[2]).toBe(32767);
    expect(Math.abs(output[3] - 32767 / 2)).toBeLessThanOrEqual(0.5);
    expect(output.every((n) => n >= 0 && n <= 32767)).toBe(true);
    await mixer.done;
  });

  it("ramps headroom to the midpoint without an endpoint level step", async () => {
    const mixer = new PlaybackMixer(source([10000, 10000, 10000, 10000]), 4, 1, retire());
    const fade = mixer.crossfade(source([10000, 10000, 10000, 10000, 10000]), 1, retire(), {
      headroomDb: 6,
    });
    await checkpoint();
    const output = await drain(mixer.output);
    await fade;
    expect(output[1]).toBe(Math.round(10000 * 10 ** (-6 / 20)));
    expect(output.slice(-2)).toEqual([10000, 10000]);
    await mixer.done;
  });

  it("attenuates outgoing bass progressively and does not leak state to the next track", async () => {
    const mixer = new PlaybackMixer(source(Array(480).fill(10000)), 48000, 1, retire());
    const fade = mixer.crossfade(source(Array(481).fill(0)), 0.01, retire(), {
      outgoingBassDb: -24,
    });
    for (let i = 0; i < 128; i++) await checkpoint();
    const output = await drain(mixer.output);
    await fade;
    // DC is in the low band; by midpoint the filter is settled and bass is -12 dB.
    expect(output[239]).toBeLessThan(1800);
    expect(output[239]).toBeGreaterThan(1000);
    expect(output.slice(-2)).toEqual([0, 0]);
    await mixer.done;
  });

  async function renderHandoff(
    old: number[],
    next: number[],
    frames: number,
    options: LiveCrossfadeOptions,
    channels = 1,
    splits: number[] = [],
  ): Promise<number[]> {
    const mixer = new PlaybackMixer(source(old, [...splits]), 48000, channels, retire());
    const token = await mixer.prepare(source(next, [...splits]), retire());
    const fade = mixer.crossfadePrepared(token, frames / 48000, options);
    const output = await drain(mixer.output);
    await fade;
    await mixer.done;
    return output;
  }

  it.each(["linear", "equalPower"] as const)(
    "hands off settled bass over the narrow window without double-applying the %s envelope",
    async (curve) => {
      const frames = 4800;
      const old = Array(frames).fill(8000);
      const next = Array(frames + 2).fill(-3000);
      const output = await renderHandoff(old, next, frames, {
        curve,
        bassHandoff: true,
        outgoingBassDb: -12,
      });
      const alpha = 1 - Math.exp((-2 * Math.PI * 180) / 48000);
      for (const progress of [0.2, 0.35, 0.425, 0.5, 0.575, 0.65, 0.8, 1]) {
        const position = Math.round(progress * frames);
        const gain = position / frames;
        const t = Math.max(0, Math.min(1, (gain - 0.35) / 0.3));
        const handoff = t * t * (3 - 2 * t);
        const bassGain = 10 ** ((-12 * gain * gain * (3 - 2 * gain)) / 20);
        const oldGain = curve === "linear" ? 1 - gain : Math.cos((gain * Math.PI) / 2);
        const nextGain = curve === "linear" ? gain : Math.sin((gain * Math.PI) / 2);
        // Independent DC responses include the one-pole's startup leakage.
        const oldLow = 8000 * (1 - (1 - alpha) ** position);
        const nextLow = -3000 * (1 - (1 - alpha) ** position);
        expect(output[position - 1]).toBe(
          Math.round(
            (8000 + ((1 - handoff) * bassGain - 1) * oldLow) * oldGain +
              (-3000 + (handoff - 1) * nextLow) * nextGain,
          ),
        );
      }
      // The handoff ends at unity incoming bass; post-fade PCM is untouched.
      expect(output.slice(-3)).toEqual([-3000, -3000, -3000]);
    },
  );

  it("reduces correlated low-frequency overlap around midpoint, allowing one-pole leakage", async () => {
    const frames = 4800;
    const signal = Array.from({ length: frames + 1 }, (_, i) =>
      Math.round(8000 * Math.sin((2 * Math.PI * 40 * i) / 48000)),
    );
    const legacy = await renderHandoff(signal.slice(0, frames), signal, frames, {
      curve: "equalPower",
    });
    const handoff = await renderHandoff(signal.slice(0, frames), signal, frames, {
      curve: "equalPower",
      bassHandoff: true,
    });
    const rms = (samples: number[]) =>
      Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    const ratio = rms(handoff.slice(2200, 2600)) / rms(legacy.slice(2200, 2600));
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.7);
    expect(handoff.at(-1)).toBe(signal.at(-1)! || 0);
  });

  it("keeps stereo handoff linked and filter histories independent across chunks", async () => {
    const frames = 4800;
    const old = Array.from({ length: frames }, (_, i) =>
      Math.round(12000 * Math.sin((2 * Math.PI * 60 * i) / 48000)),
    );
    const next = Array.from({ length: frames + 2 }, (_, i) =>
      Math.round(9000 * Math.cos((2 * Math.PI * 90 * i) / 48000)),
    );
    const options = { curve: "equalPower", bassHandoff: true } as const;
    const mono = await renderHandoff(old, next, frames, options);
    const stereo = await renderHandoff(
      old.flatMap((sample) => [sample, -sample]),
      next.flatMap((sample) => [sample, -sample]),
      frames,
      options,
      2,
      [1, 7, 11, 4093, 3],
    );
    for (let i = 0; i < mono.length; i++) {
      expect(stereo[i * 2]).toBe(mono[i]);
      expect(Math.abs(stereo[i * 2 + 1]! + mono[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it.each([{}, { curve: "equalPower", outgoingBassDb: -12, headroomDb: 3 }] as const)(
    "keeps unset and false handoff byte-identical to the legacy calculation: %j",
    async (options) => {
      const frames = 1200;
      const old = Array.from({ length: frames }, (_, i) => (i % 7) * 9000 - 30000);
      const next = Array.from({ length: frames + 1 }, (_, i) => (i % 5) * 14000 - 30000);
      const unset = await renderHandoff(old, next, frames, options);
      const disabled = await renderHandoff(old, next, frames, { ...options, bassHandoff: false });
      const legacyOptions: LiveCrossfadeOptions = options;
      const alpha = 1 - Math.exp((-2 * Math.PI * 180) / 48000);
      let low = 0;
      const expected = old.map((sample, i) => {
        const gain = (i + 1) / frames;
        const equalPower = legacyOptions.curve === "equalPower";
        const oldGain = equalPower ? Math.cos((gain * Math.PI) / 2) : 1 - gain;
        const nextGain = equalPower ? Math.sin((gain * Math.PI) / 2) : gain;
        const smooth = gain * gain * (3 - 2 * gain);
        const bassGain = 10 ** (((legacyOptions.outgoingBassDb ?? 0) * smooth) / 20);
        const headroom = 10 ** ((-(legacyOptions.headroomDb ?? 0) * Math.sin(Math.PI * gain)) / 20);
        low += alpha * (sample - low);
        const mixed = ((sample + (bassGain - 1) * low) * oldGain + next[i]! * nextGain) * headroom;
        const shaped = equalPower || !!legacyOptions.outgoingBassDb || !!legacyOptions.headroomDb;
        const protection = shaped ? 32767 / Math.max(32767, Math.abs(mixed)) : 1;
        return Math.max(-32768, Math.min(32767, Math.round(mixed * protection)));
      });
      expected.push(next[frames]!);
      expect(unset).toEqual(expected);
      expect(disabled).toEqual(expected);
    },
  );

  it("rejects invalid options before locking the next stream and keeps playback usable", async () => {
    const mixer = new PlaybackMixer(source([123]), 48000, 1, retire());
    for (const options of [
      { headroomDb: NaN },
      { outgoingBassDb: 1 },
      { startTime: -1 },
      { bassCutoffHz: 0 },
      { curve: "bogus" },
      { bassHandoff: 1 },
      { bassHandoff: "true" },
      { bassHandoff: null },
    ]) {
      const next = source([456]);
      await expect(mixer.crossfade(next, 1, retire(), options as any)).rejects.toThrow();
      expect(next.locked).toBe(false);
    }
    expect(await drain(mixer.output)).toEqual([123]);
    await mixer.done;
  });
});
