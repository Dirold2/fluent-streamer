import { afterEach, describe, expect, it, vi } from "vitest";
import { ThrottleStream } from "../src/Core/ThrottleStream.js";

afterEach(() => vi.useRealTimers());

describe("ThrottleStream playback pacing", () => {
  function setup() {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stream = new ThrottleStream(1000);
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    return {
      reader,
      writer,
      stall: (ms: number) => {
        now += ms;
      },
      advance: async (ms: number) => {
        now += ms;
        await vi.advanceTimersByTimeAsync(ms);
      },
    };
  }

  it("does not count FFmpeg startup latency as already played audio", async () => {
    const { reader, writer, advance } = setup();
    await advance(400);
    let delivered = false;
    const read = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    const write = writer.write(new Uint8Array(100));
    await advance(0);
    expect(delivered).toBe(false);
    await advance(99);
    expect(delivered).toBe(false);
    await advance(1);
    expect((await read).value?.length).toBe(100);
    await write;
    await writer.close();
  });

  it("does not burst queued audio after a 400 ms consumer pause", async () => {
    const { reader, writer, advance } = setup();
    const first = reader.read();
    const firstWrite = writer.write(new Uint8Array(100));
    await advance(0);
    await advance(100);
    await first;
    await firstWrite;
    await advance(400);
    let delivered = false;
    const read = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    const write = writer.write(new Uint8Array(100));
    await advance(0);
    expect(delivered).toBe(false);
    await advance(100);
    await read;
    await write;
    await writer.close();
  });

  it("does not repay a late timer with a burst of subsequent audio", async () => {
    const { reader, writer, advance, stall } = setup();
    const first = reader.read();
    const firstWrite = writer.write(new Uint8Array(100));
    await advance(0);
    stall(300);
    await advance(100);
    await first;
    await firstWrite;
    let delivered = false;
    const read = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    const write = writer.write(new Uint8Array(100));
    await advance(0);
    expect(delivered).toBe(false);
    await advance(100);
    await read;
    await write;
    await writer.close();
  });

  it("preserves all bytes and paces unequal chunks without a startup burst", async () => {
    const { reader, writer, advance } = setup();
    await advance(350);
    for (const size of [10, 100, 37, 600, 20]) {
      let delivered = false;
      const read = reader.read().then((result) => {
        delivered = true;
        return result;
      });
      const chunk = new Uint8Array(size).fill(size % 256);
      const write = writer.write(chunk);
      await advance(0);
      expect(delivered).toBe(false);
      await advance(size);
      expect((await read).value).toEqual(chunk);
      await write;
    }
    await writer.close();
  });
});
