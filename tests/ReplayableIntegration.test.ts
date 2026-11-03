import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  FluentStream,
  analyzeTrack,
  type FFmpegRunResultExtended,
  type ProcessorOptions,
  type ReplayableStreamSource,
} from "../src/index.js";

const hasFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const rate = 48000;
const frameBytes = 4;
const directory = mkdtempSync(join(tmpdir(), "replayable-integration-"));
const fixture = join(directory, "tone.wav");

function header(dataBytes: number) {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataBytes, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * frameBytes, 28);
  bytes.writeUInt16LE(frameBytes, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

// Non-periodic PCM makes an incorrect seek offset observable without another decoder.
const pcm = Buffer.alloc(6 * rate * frameBytes);
for (let frame = 0; frame < pcm.length / frameBytes; frame++) {
  pcm.writeInt16LE(((frame * 97) % 24001) - 12000, frame * frameBytes);
  pcm.writeInt16LE(((frame * 193) % 22001) - 11000, frame * frameBytes + 2);
}
const wav = Buffer.concat([header(pcm.length), pcm]);
writeFileSync(fixture, wav);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function bounded<T>(promise: T | PromiseLike<T>, label: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

const runs = new Set<FFmpegRunResultExtended>();
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const aborters = new Set<AbortController>();
const servers = new Set<Server>();

async function serveWav() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      Connection: "close",
    });
    response.end(wav);
  });
  servers.add(server);
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    }),
    "HTTP listen",
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
  return { url: `http://127.0.0.1:${address.port}/tone.wav`, requests };
}
afterEach(async () => {
  for (const controller of aborters) controller.abort();
  try {
    await bounded(Promise.allSettled([...runs].map((result) => result.stop())), "stop runs");
  } finally {
    await bounded(
      Promise.allSettled(
        [...readers].map(async (reader) => {
          try {
            await reader.cancel().catch(() => {});
          } finally {
            reader.releaseLock();
          }
        }),
      ),
      "cancel readers",
    );
    await bounded(
      Promise.all(
        [...servers].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      ),
      "close HTTP servers",
    );
    servers.clear();
    runs.clear();
    readers.clear();
    aborters.clear();
    vi.restoreAllMocks();
  }
});

function controller() {
  const aborter = new AbortController();
  aborters.add(aborter);
  return aborter;
}

function source(asyncOpen = false) {
  const streams: ReadableStream<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const open = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(target) {
        if (offset === wav.length) return target.close();
        const end = Math.min(offset + 16384, wav.length);
        target.enqueue(wav.subarray(offset, end));
        offset = end;
      },
    });
    streams.push(stream);
    return asyncOpen ? Promise.resolve(stream) : stream;
  });
  return { open, streams, signals } satisfies ReplayableStreamSource & {
    streams: ReadableStream<Uint8Array>[];
    signals: AbortSignal[];
  };
}

function pendingSource() {
  let resolveOpen!: (stream: ReadableStream<Uint8Array>) => void;
  const signals: AbortSignal[] = [];
  const open = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpen = resolve;
    });
  });
  const cancel = vi.fn();
  const lateStream = new ReadableStream<Uint8Array>({ cancel });
  return {
    open,
    signals,
    cancel,
    lateStream,
    resolve: () => resolveOpen(lateStream),
  };
}

function track(
  input: string | ReplayableStreamSource,
  enableCrossfade = false,
  options: Partial<ProcessorOptions> = {},
) {
  return new FluentStream({
    enableCrossfade,
    autoDrainOutput: false,
    disableThrottling: true,
    ...options,
  })
    .input(input)
    .audioCodec("pcm_s16le")
    .outputOptions("-vn", "-f", "s16le", "-ar", String(rate), "-ac", "2")
    .output(FluentStream.stdout);
}

async function start(fluent: FluentStream) {
  const result = await bounded(fluent.run(), "run");
  runs.add(result);
  void result.done.catch(() => {});
  const reader = result.output.getReader();
  readers.add(reader);
  return { result, reader };
}

async function chunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const value = await bounded(reader.read(), "PCM read");
  expect(value.done).toBe(false);
  expect(value.value!.byteLength).toBeGreaterThan(0);
  expect(value.value!.byteLength % frameBytes).toBe(0);
  return Buffer.from(value.value!);
}

function expectPcmEqual(actual: Buffer, expected: Buffer) {
  // Compare every byte natively: deep equality walks megabytes of Buffer properties.
  expect(actual.length).toBe(expected.length);
  expect(actual.equals(expected), "decoded PCM must match every expected byte").toBe(true);
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Buffer[] = [];
  return bounded(
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks);
        chunks.push(Buffer.from(value));
      }
    })(),
    "PCM EOF",
  );
}

async function consumeTransition(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  transition: Promise<void>,
) {
  let settled = false;
  const completion = transition.finally(() => {
    settled = true;
  });
  void completion.catch(() => {});
  await bounded(
    (async () => {
      while (!settled) {
        await chunk(reader);
        await delay(2);
      }
      await completion;
    })(),
    "transition",
  );
}

describe.skipIf(!hasFFmpeg)("public replayable source integration", { timeout: 20000 }, () => {
  it.each([false, true])(
    "opens lazily and decodes exact PCM (async open=%s)",
    async (asyncOpen) => {
      const factory = source(asyncOpen);
      const fluent = track(factory);
      expect(factory.open).not.toHaveBeenCalled();
      const { result, reader } = await start(fluent);
      expectPcmEqual(await drain(reader), pcm);
      await bounded(result.done, "done");
      expect(factory.open).toHaveBeenCalledTimes(1);
      expect(factory.signals[0]).toBeInstanceOf(AbortSignal);
      expect(factory.streams[0]!.locked).toBe(false);
    },
  );

  it.each([false, true])(
    "reopens distinct streams on repeated absolute seeks (mixed=%s)",
    async (mixed) => {
      const factory = source(true);
      const spawned: string[][] = [];
      const fluent = track(factory, mixed, {
        onBeforeChildProcessSpawn: (_path, args) => {
          spawned.push([...args]);
        },
      });
      let { result, reader } = await start(fluent);
      const output = result.output;
      const done = result.done;
      await chunk(reader);
      for (const position of [1, 2]) {
        const pending = fluent.seek(position);
        if (mixed)
          await consumeTransition(
            reader,
            pending.then(() => {}),
          );
        const replacement = await bounded(pending, "seek");
        runs.add(replacement);
        void replacement.done.catch(() => {});
        if (mixed) {
          expect(replacement).toBe(result);
          expect(replacement.output).toBe(output);
          expect(replacement.done).toBe(done);
        } else {
          expect(replacement).not.toBe(result);
          reader = replacement.output.getReader();
          readers.add(reader);
          result = replacement;
        }
        expect(factory.open).toHaveBeenCalledTimes(position + 1);
        expect(new Set(factory.streams).size).toBe(position + 1);
        const args = spawned.at(-1)!;
        const input = args.indexOf("-i");
        expect(args[input + 1]).toBe("pipe:0");
        expect(args.indexOf("-ss")).toBeGreaterThan(input + 1);
        expect(args[args.indexOf("-ss") + 1]).toBe(String(position));
        expect(args.filter((arg) => arg === "-ss")).toHaveLength(1);
        if (position === 1) await chunk(reader);
      }
      const tail = await drain(reader);
      const reference = pcm.subarray(2 * rate * frameBytes);
      if (mixed) {
        // Mixed seek includes the click-suppression ramp and possibly buffered outgoing PCM.
        expect(tail.length).toBeGreaterThan(4096);
        expectPcmEqual(tail.subarray(-4096), reference.subarray(-4096));
      } else {
        expectPcmEqual(tail, reference);
      }
      await bounded(result.done, "seek done");
    },
  );

  it("backpressures a large generated input and cancels a live producer on stop", async () => {
    const dataBytes = 1800 * rate * frameBytes;
    let supplied = 0;
    const cancel = vi.fn();
    let signal: AbortSignal | undefined;
    const factory: ReplayableStreamSource = {
      open(value) {
        signal = value;
        let first = true;
        return new ReadableStream<Uint8Array>({
          pull(target) {
            if (first) {
              first = false;
              target.enqueue(header(dataBytes));
            } else if (supplied < dataBytes) {
              const length = Math.min(16384, dataBytes - supplied);
              supplied += length;
              target.enqueue(new Uint8Array(length));
            } else target.close();
          },
          cancel,
        });
      },
    };
    const { result, reader } = await start(track(factory));
    await chunk(reader);
    await delay(150);
    const before = supplied;
    await delay(150);
    expect(supplied).toBeLessThan(dataBytes);
    // Allow bounded OS/FFmpeg buffering, but not an unbounded eager drain.
    expect(supplied - before).toBeLessThan(4 * 1024 * 1024);
    await bounded(result.stop(), "stop backpressured producer");
    await until(() => cancel.mock.calls.length > 0, "producer cancellation");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(signal!.aborted).toBe(true);
  });

  it.each(["factory-file", "file-factory", "factory-factory"] as const)(
    "crossfades %s without replacing the output",
    async (direction) => {
      const outgoing = source();
      const incoming = source(true);
      const fluent = track(direction === "file-factory" ? fixture : outgoing, true);
      const { result, reader } = await start(fluent);
      const output = result.output;
      const done = result.done;
      await chunk(reader);
      await consumeTransition(
        reader,
        fluent.crossfade(direction === "factory-file" ? fixture : incoming, 0.04),
      );
      expect(result.output).toBe(output);
      expect(result.done).toBe(done);
      const tail = await drain(reader);
      expect(tail.length).toBeGreaterThan(4096);
      expectPcmEqual(tail.subarray(-4096), pcm.subarray(-4096));
      await bounded(done, "crossfade done");
      expect(outgoing.open).toHaveBeenCalledTimes(direction === "file-factory" ? 0 : 1);
      expect(incoming.open).toHaveBeenCalledTimes(direction === "factory-file" ? 0 : 1);
    },
  );

  it.each(["URL-factory", "factory-URL"] as const)(
    "crossfades %s over loopback HTTP without replacing the mixed session",
    async (direction) => {
      const { url, requests } = await serveWav();
      const factory = source(true);
      const fluent = track(direction === "URL-factory" ? url : factory, true);
      const { result, reader } = await start(fluent);
      const { output, done } = result;
      const first = await chunk(reader);
      expectPcmEqual(first, pcm.subarray(0, first.length));
      if (direction === "URL-factory") expect(requests.length).toBeGreaterThan(0);
      await consumeTransition(
        reader,
        fluent.crossfade(direction === "URL-factory" ? factory : url, 0.04),
      );
      expect(result.output).toBe(output);
      expect(result.passthrough).toBe(output);
      expect(result.done).toBe(done);
      expect(factory.open).toHaveBeenCalledTimes(1);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((path) => path === "/tone.wav")).toBe(true);
      const tail = await drain(reader);
      expect(tail.length).toBeGreaterThan(4096);
      expectPcmEqual(tail.subarray(-4096), pcm.subarray(-4096));
      await bounded(done, "HTTP crossfade done");
    },
  );

  it("analyzes a factory window through an independent opening without consuming playback", async () => {
    const factory = source(true);
    const { result, reader } = await start(track(factory, true));
    const analysis = await bounded(
      analyzeTrack(factory, { startSeconds: 1, timeout: 10000 }),
      "factory window analysis",
      12000,
    );
    expect(analysis.analyzedDurationMs).toBeGreaterThan(4900);
    expect(analysis.analyzedDurationMs).toBeLessThanOrEqual(5000);
    expect(factory.open).toHaveBeenCalledTimes(2);
    expect(new Set(factory.streams).size).toBe(2);
    expect(factory.signals[1]).not.toBe(factory.signals[0]);
    expect(factory.streams[1]!.locked).toBe(false);
    // EOF may already have retired the playback input; intact PCM proves isolation.
    expectPcmEqual(await drain(reader), pcm);
    await bounded(result.done, "playback after analysis");
  });

  it("cancels a pending independent analysis read without aborting factory playback", async () => {
    const playback = source();
    const aborter = controller();
    const cancel = vi.fn();
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const signals: AbortSignal[] = [];
    const open = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1
        ? playback.open(signal)
        : new ReadableStream<Uint8Array>({ pull, cancel });
    });
    const { result, reader } = await start(track({ open }, true));
    const pending = analyzeTrack(
      { open },
      {
        startSeconds: 1,
        signal: aborter.signal,
        timeout: 10000,
      },
    );
    const rejected = expect(pending).rejects.toThrow();
    await until(() => pull.mock.calls.length > 0, "analysis pending read");
    expect(open).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
    aborter.abort();
    await bounded(rejected, "abort factory analysis");
    await until(() => cancel.mock.calls.length === 1, "cancel analysis source");
    expect(signals[1]!.aborted).toBe(true);
    // The playback input may naturally reach EOF before the analysis is cancelled.
    expectPcmEqual(await drain(reader), pcm);
    await bounded(result.done, "playback after analysis cancellation");
  });

  it("prepares non-seamless automix with separate uncached factory analysis openings", async () => {
    const outgoing = source(true);
    const incoming = source(true);
    const fluent = track(outgoing, true);
    const { result, reader } = await start(fluent);
    // No cached analyses: each source must be opened for analysis independently
    // of the outgoing playback and the prepared incoming decoder.
    const prepared = await bounded(
      fluent.prepareAutomix(incoming, {
        transitionMode: "crossfade",
        outgoingRemainingMs: 6000,
        incomingDurationMs: 6000,
        transitionOverride: { startMs: 1000, cueMs: 0, seconds: 0.1 },
      }),
      "uncached factory automix",
      15000,
    );
    expect(outgoing.open).toHaveBeenCalledTimes(2);
    expect(incoming.open).toHaveBeenCalledTimes(2);
    expect(new Set([...outgoing.streams, ...incoming.streams]).size).toBe(4);
    expect(new Set([...outgoing.signals, ...incoming.signals]).size).toBe(4);
    expect(outgoing.streams[1]!.locked).toBe(false);
    expect(incoming.streams[0]!.locked).toBe(false);
    expect(prepared.plan).toMatchObject({ startMs: 1000, cueMs: 0, seconds: 0.1 });
    const { output, done } = result;
    await consumeTransition(reader, prepared.start());
    expect(outgoing.open).toHaveBeenCalledTimes(2);
    expect(incoming.open).toHaveBeenCalledTimes(2);
    expect(result.output).toBe(output);
    expect(result.done).toBe(done);
    const tail = await drain(reader);
    expectPcmEqual(tail.subarray(-4096), pcm.subarray(-4096));
    await bounded(done, "uncached automix done");
  });

  it.each(["crossfade", "seek"] as const)(
    "mixed stop rejects a pending %s factory open and cancels its late stream",
    async (operation) => {
      const original = source();
      const pending = pendingSource();
      // Seeking reopens the same public source; only its second open stalls.
      const open = vi.fn((signal: AbortSignal) =>
        original.open.mock.calls.length === 0 ? original.open(signal) : pending.open(signal),
      );
      const fluent = track(operation === "seek" ? { open } : original, true);
      const { result, reader } = await start(fluent);
      await chunk(reader);
      const transition = operation === "seek" ? fluent.seek(1) : fluent.crossfade(pending, 0.04);
      const rejected = expect(transition).rejects.toThrow();
      try {
        await until(() => pending.open.mock.calls.length === 1, "pending transition open");
        expect(pending.signals[0]!.aborted).toBe(false);
        // Neither stop nor rejection may depend on the factory resolving.
        await bounded(
          Promise.all([result.stop(), rejected, result.done]),
          "stop pending transition",
          2000,
        );
        expect(pending.signals[0]!.aborted).toBe(true);
        await until(() => !original.streams[0]!.locked, "release original input");
        expect(original.signals[0]!.aborted).toBe(true);
        await bounded(drain(reader), "stopped mixed output EOF", 2000);
        await expect(fluent.crossfade(fixture, 0.04)).rejects.toThrow();
      } finally {
        // A factory need not cooperate with abort; late ownership still belongs to the run.
        if (pending.open.mock.calls.length) {
          pending.resolve();
          await until(
            () => pending.cancel.mock.calls.length === 1,
            "cancel late transition stream",
          );
          expect(pending.lateStream.locked).toBe(false);
        }
      }
      expect(pending.open).toHaveBeenCalledTimes(1);
      expect(original.open).toHaveBeenCalledTimes(1);
      await bounded(result.stop(), "idempotent mixed stop", 2000);
    },
  );

  it("caller abort rejects seamless preparation during factory open and cancels its late stream", async () => {
    const original = source();
    const pending = pendingSource();
    const aborter = controller();
    const fluent = track(original, true);
    const { result, reader } = await start(fluent);
    const { output, done } = result;
    const preparation = fluent.prepareAutomix(pending, {
      transitionMode: "seamless",
      outgoingRemainingMs: 6000,
      incomingDurationMs: 6000,
      transitionOverride: { startMs: 1000, cueMs: 0, seconds: 0.1 },
      signal: aborter.signal,
    });
    const rejected = expect(preparation).rejects.toThrow();
    try {
      await until(() => pending.open.mock.calls.length === 1, "pending prepared open");
      expect(pending.signals[0]!.aborted).toBe(false);
      aborter.abort();
      await bounded(rejected, "abort pending preparation", 2000);
      expect(pending.signals[0]!.aborted).toBe(true);
    } finally {
      aborter.abort();
      if (pending.open.mock.calls.length) {
        pending.resolve();
        await until(() => pending.cancel.mock.calls.length === 1, "cancel late prepared stream");
        expect(pending.lateStream.locked).toBe(false);
      }
    }
    expect(result.output).toBe(output);
    expect(result.done).toBe(done);
    expect(original.open).toHaveBeenCalledTimes(1);
    // Cancellation releases the reservation without consuming or stopping the original.
    const replacement = await bounded(
      fluent.prepareAutomix(fixture, {
        transitionMode: "seamless",
        outgoingRemainingMs: 6000,
        incomingDurationMs: 6000,
        transitionOverride: { startMs: 1000, cueMs: 0, seconds: 0.1 },
      }),
      "prepare after caller abort",
    );
    await bounded(replacement.cancel(), "cancel replacement");
    expectPcmEqual(await drain(reader), pcm);
    await bounded(done, "original EOF after preparation abort");
    await until(() => !original.streams[0]!.locked, "release original after EOF");
    expect(pending.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels seamless preparation and activates a replacement without reopening its prepared factory", async () => {
    const outgoing = source();
    const discarded = source(true);
    const incoming = source(true);
    const fluent = track(outgoing, true);
    const { result, reader } = await start(fluent);
    const options = {
      transitionMode: "seamless" as const,
      outgoingRemainingMs: 3000,
      incomingDurationMs: 6000,
      transitionOverride: { startMs: 1000, cueMs: 0, seconds: 0.1 },
    };
    const prepared = await bounded(fluent.prepareAutomix(discarded, options), "prepare discarded");
    expect(prepared.plan.reason).toBe("seamless");
    expect(discarded.open).toHaveBeenCalledTimes(1);
    await bounded(prepared.cancel(), "cancel prepared");
    await bounded(prepared.cancel(), "cancel prepared twice");
    expect(discarded.signals[0]!.aborted).toBe(true);
    await until(() => !discarded.streams[0]!.locked, "release discarded stream");
    await expect(prepared.start()).rejects.toThrow();
    const replacement = await bounded(
      fluent.prepareAutomix(incoming, options),
      "prepare replacement",
    );
    expect(incoming.open).toHaveBeenCalledTimes(1);
    const output = result.output;
    const done = result.done;
    await consumeTransition(reader, replacement.start());
    expect(incoming.open).toHaveBeenCalledTimes(1);
    expect(outgoing.open).toHaveBeenCalledTimes(1);
    expect(result.output).toBe(output);
    expect(result.done).toBe(done);
    const tail = await drain(reader);
    expectPcmEqual(tail.subarray(-4096), pcm.subarray(-4096));
    await bounded(done, "prepared done");
  });

  it.each([false, true])(
    "external abort rejects a pending initial open and retires its late stream (mixed=%s)",
    async (mixed) => {
      const aborter = controller();
      let resolveOpen!: (stream: ReadableStream<Uint8Array>) => void;
      let signal: AbortSignal | undefined;
      const entered = vi.fn();
      const factory: ReplayableStreamSource = {
        open(value) {
          signal = value;
          entered();
          return new Promise((resolve) => {
            resolveOpen = resolve;
          });
        },
      };
      const pending = track(factory, mixed, { abortSignal: aborter.signal }).run();
      const rejected = expect(pending).rejects.toThrow();
      await until(() => entered.mock.calls.length === 1, "enter pending open");
      aborter.abort();
      try {
        await bounded(rejected, "abort pending open");
        expect(signal!.aborted).toBe(true);
      } finally {
        const cancel = vi.fn();
        resolveOpen(new ReadableStream<Uint8Array>({ cancel }));
        await until(() => cancel.mock.calls.length === 1, "cancel late open result");
      }
    },
  );

  it.each([false, true])(
    "external abort cancels a pending source read (mixed=%s)",
    async (mixed) => {
      const aborter = controller();
      const cancel = vi.fn();
      let signal: AbortSignal | undefined;
      const pull = vi.fn(() => new Promise<void>(() => {}));
      const factory: ReplayableStreamSource = {
        open(value) {
          signal = value;
          return new ReadableStream<Uint8Array>({ pull, cancel });
        },
      };
      const { result, reader } = await start(
        track(factory, mixed, { abortSignal: aborter.signal }),
      );
      const read = reader.read().then(
        () => "closed",
        () => "rejected",
      );
      const done = result.done.then(
        () => "resolved",
        () => "rejected",
      );
      await until(() => pull.mock.calls.length > 0, "pending read");
      aborter.abort();
      await bounded(done, "abort run completion");
      await bounded(read, "abort public output read");
      await until(() => cancel.mock.calls.length === 1, "cancel pending source read");
      expect(signal!.aborted).toBe(true);
    },
  );
});
