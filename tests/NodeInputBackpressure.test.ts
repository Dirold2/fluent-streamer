import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import FluentStream from "../src/Fluent/FluentStream.js";

function adapt(source: Readable): ReadableStream<Uint8Array> {
  const fluent = new FluentStream().input(source);
  return (fluent as unknown as {
    inputStreams: Array<{ stream: ReadableStream<Uint8Array> }>;
  }).inputStreams[0]!.stream;
}

function expectDetached(source: Readable) {
  for (const event of ["data", "end", "error", "close"]) {
    expect(source.listenerCount(event)).toBe(0);
  }
}

describe("Fluent Node input backpressure", () => {
  it("bounds read-ahead, resumes on demand, and preserves all bytes", async () => {
    let produced = 0;
    const total = 256;
    const source = new Readable({
      highWaterMark: 16 * 1024,
      read() {
        if (produced === total) this.push(null);
        else this.push(Buffer.alloc(16 * 1024, produced++));
      },
    });
    const stream = adapt(source);
    await vi.waitFor(() => {
      expect(produced).toBeGreaterThan(0);
      expect(source.readableFlowing).toBe(false);
    });
    expect(produced).toBeLessThanOrEqual(5);
    const pausedAt = produced;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced).toBe(pausedAt);

    const reader = stream.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBe(16 * 1024);
      expect(value.every((byte) => byte === received)).toBe(true);
      received++;
      if (received % 16 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(produced - received).toBeLessThanOrEqual(5);
      }
    }
    expect(received).toBe(total);
    expectDetached(source);
  });

  it.each([undefined, "stop", new Error("cancelled")])(
    "destroys and detaches the source on cancel (%s)",
    async (reason) => {
      const source = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
      const stream = adapt(source);
      await stream.cancel(reason);
      await vi.waitFor(() => expectDetached(source));
      expect(source.destroyed).toBe(true);
    },
  );

  it("handles errors from a custom destroy during cancellation", async () => {
    const source = new Readable({
      read() {},
      destroy(_error, callback) { callback(new Error("destroy failed")); },
    });
    await adapt(source).cancel();
    await vi.waitFor(() => expectDetached(source));
  });

  it("forwards source errors and removes its listeners", async () => {
    const source = new Readable({ read() {} });
    const reader = adapt(source).getReader();
    const error = new Error("input failed");
    const result = expect(reader.read()).rejects.toBe(error);
    source.destroy(error);
    await result;
    expectDetached(source);
  });

  it("rejects on premature close instead of hanging", async () => {
    const source = new Readable({ read() {} });
    const reader = adapt(source).getReader();
    const result = expect(reader.read()).rejects.toThrow("closed before ending");
    source.destroy();
    await result;
    expectDetached(source);
  });

  it("handles an already ended source", async () => {
    const source = Readable.from([]);
    source.resume();
    await new Promise<void>((resolve) => source.once("end", resolve));
    await expect(adapt(source).getReader().read()).resolves.toEqual({ done: true, value: undefined });
    expectDetached(source);
  });

  it("handles an error queued before adaptation", async () => {
    const source = new Readable({ read() {} });
    const error = new Error("already destroyed");
    source.destroy(error);
    await expect(adapt(source).getReader().read()).rejects.toBe(error);
    await vi.waitFor(() => expectDetached(source));
  });

  it("handles an already destroyed source", async () => {
    const source = new Readable({ read() {} });
    source.destroy();
    await new Promise<void>((resolve) => source.once("close", resolve));
    await expect(adapt(source).getReader().read()).rejects.toThrow("closed before ending");
    expectDetached(source);
  });
});
