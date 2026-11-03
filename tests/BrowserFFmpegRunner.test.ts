import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserFFmpegRunner } from "../src/Runner/runners/browser.js";

const mock = vi.hoisted(() => ({
  load: vi.fn(),
  exec: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  terminate: vi.fn(),
  on: vi.fn(),
  constructed: vi.fn(),
}));

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    constructor() {
      mock.constructed();
    }
    load = mock.load;
    exec = mock.exec;
    writeFile = mock.writeFile;
    readFile = mock.readFile;
    terminate = mock.terminate;
    on = mock.on;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mock.load.mockResolvedValue(undefined);
  mock.exec.mockResolvedValue(0);
  mock.writeFile.mockResolvedValue(undefined);
  mock.readFile.mockResolvedValue(new Uint8Array([7, 8]));
});
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function spawn(args = ["-i", "pipe:0", "pipe:1"]) {
  const process = new BrowserFFmpegRunner().spawn("ignored", args);
  const exit = vi.fn();
  process.onExit(exit);
  return { process, exit };
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: number[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(...value);
  }
  return chunks;
}

it("preserves batch input copying and exposes output only after exec", async () => {
  const exec = deferred<number>();
  mock.exec.mockReturnValue(exec.promise);
  const { process, exit } = spawn();
  const writer = process.stdin!.getWriter();
  const chunk = new Uint8Array([1, 2]);
  await writer.write(chunk);
  chunk[0] = 9;
  await writer.write(new Uint8Array([3]));
  expect(mock.load).not.toHaveBeenCalled();
  await writer.close();
  await vi.waitFor(() => expect(mock.exec).toHaveBeenCalled());
  expect(mock.writeFile).toHaveBeenCalledWith("stdin_0.raw", new Uint8Array([1, 2, 3]));
  expect(mock.exec).toHaveBeenCalledWith(["-i", "stdin_0.raw", "output.raw"]);
  expect(mock.readFile).not.toHaveBeenCalled();
  exec.resolve(0);
  expect(await drain(process.stdout)).toEqual([7, 8]);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, null));
  expect(mock.terminate).toHaveBeenCalledTimes(1);
});

it.each(["kill", "abort"])("settles pending input on %s without loading WASM", async (action) => {
  const { process, exit } = spawn();
  const writer = process.stdin!.getWriter();
  const closed = writer.closed.catch(() => {});
  await writer.write(new Uint8Array([1]));
  if (action === "kill") process.kill("SIGTERM");
  else await writer.abort(new Error("input failed"));
  await closed;
  process.kill("SIGKILL");
  const late = vi.fn();
  process.onExit(late);
  expect(exit).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
  expect(late).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
  expect(await drain(process.stdout)).toEqual([]);
  expect(await drain(process.stderr)).toEqual([]);
  await Promise.resolve();
  expect(mock.constructed).not.toHaveBeenCalled();
  if (action === "kill") await expect(writer.write(new Uint8Array([2]))).rejects.toThrow("exited");
});

it.each(["load", "exec", "readFile"] as const)(
  "ignores late rejection after kill during %s",
  async (stage) => {
    const pending = deferred<never>();
    mock[stage].mockReturnValue(pending.promise);
    const { process, exit } = spawn(["pipe:1"]);
    await vi.waitFor(() => expect(mock[stage]).toHaveBeenCalled());
    process.kill("SIGTERM");
    pending.reject(new Error("worker terminated"));
    await new Promise((r) => setTimeout(r, 20));
    expect(exit).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
    expect(mock.terminate).toHaveBeenCalledTimes(1);
    expect(await drain(process.stderr)).toEqual([]);
    expect(await drain(process.stdout)).toEqual([]);
  },
);

it.each(["load", "writeFile", "exec", "readFile"] as const)(
  "cleans up and reports %s errors",
  async (stage) => {
    mock[stage].mockRejectedValue(new Error(`${stage} failed`));
    const { process, exit } = spawn();
    await process.stdin!.close();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1, null));
    expect(new TextDecoder().decode(new Uint8Array(await drain(process.stderr)))).toContain(
      `${stage} failed`,
    );
    expect(mock.terminate).toHaveBeenCalledTimes(1);
    process.kill("SIGKILL");
    const late = vi.fn();
    process.onExit(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(1, null);
    expect(exit).toHaveBeenCalledTimes(1);
  },
);

it("reports numeric nonzero exec status without reading output", async () => {
  mock.exec.mockResolvedValue(23);
  const { process, exit } = spawn(["pipe:1"]);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(23, null));
  expect(mock.readFile).not.toHaveBeenCalled();
  expect(await drain(process.stdout)).toEqual([]);
  expect(mock.terminate).toHaveBeenCalledTimes(1);
  const late = vi.fn();
  process.onExit(late);
  process.kill("SIGKILL");
  expect(late).toHaveBeenCalledExactlyOnceWith(23, null);
  expect(exit).toHaveBeenCalledTimes(1);
});

it("preserves an exec rejection's numeric exitCode", async () => {
  mock.exec.mockRejectedValue(Object.assign(new Error("exec failed"), { exitCode: 9 }));
  const { exit } = spawn([]);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(9, null));
  expect(mock.terminate).toHaveBeenCalledTimes(1);
});

it.each(["request", "body"])("aborts pending fetch %s on kill", async (stage) => {
  const pending = deferred<never>();
  const body = vi.fn(() => pending.promise);
  const fetchMock = vi.fn((_url: string, options: RequestInit) => {
    options.signal!.addEventListener("abort", () => pending.reject(new Error("aborted")));
    return stage === "request" ? pending.promise : Promise.resolve({ ok: true, arrayBuffer: body });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { process, exit } = spawn(["-i", "https://example.test/input?token=secret", "pipe:1"]);
  await vi.waitFor(() => expect(stage === "request" ? fetchMock : body).toHaveBeenCalled());
  process.kill("SIGTERM");
  expect(fetchMock.mock.calls[0]![1].signal!.aborted).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(exit).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
  expect(mock.writeFile).not.toHaveBeenCalled();
  expect(mock.exec).not.toHaveBeenCalled();
  expect(mock.terminate).toHaveBeenCalledTimes(1);
  expect(await drain(process.stderr)).toEqual([]);
});

it.each(["http", "request", "body"])(
  "redacts signed URLs from fetch %s failures",
  async (stage) => {
    const url = "https://user:password@example.test/input?token=secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (stage === "request") throw new Error(`fetch failed: ${url}`);
        return {
          ok: stage !== "http",
          status: 403,
          arrayBuffer: async () => {
            throw new Error(`body failed: ${url}`);
          },
        };
      }),
    );
    const { process, exit } = spawn(["-i", url, "pipe:1"]);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1, null));
    const stderr = new TextDecoder().decode(new Uint8Array(await drain(process.stderr)));
    expect(stderr).toContain("Failed to fetch browser FFmpeg input");
    expect(stderr).not.toMatch(/secret|password|example\.test/);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.terminate).toHaveBeenCalledTimes(1);
  },
);

it("notifies other subscribers even if cleanup or a subscriber throws", async () => {
  mock.terminate.mockImplementation(() => {
    throw new Error("cleanup failed");
  });
  const { process, exit } = spawn([]);
  process.onExit(() => {
    throw new Error("subscriber failed");
  });
  const other = vi.fn();
  process.onExit(other);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, null));
  expect(other).toHaveBeenCalledExactlyOnceWith(0, null);
  expect(mock.terminate).toHaveBeenCalledTimes(1);
});

it.each(["load", "writeFile", "exec", "readFile"] as const)(
  "does not resume work after a late successful %s completion following kill",
  async (stage) => {
    const pending = deferred<unknown>();
    mock[stage].mockReturnValue(pending.promise);
    const { process, exit } = spawn();
    await process.stdin!.close();
    await vi.waitFor(() => expect(mock[stage]).toHaveBeenCalled());
    process.kill("SIGTERM");
    pending.resolve(stage === "exec" ? 0 : new Uint8Array([9]));
    await new Promise((r) => setTimeout(r, 20));
    expect(exit).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
    expect(mock.terminate).toHaveBeenCalledTimes(1);
    expect(await drain(process.stdout)).toEqual([]);
    if (stage === "load") expect(mock.writeFile).not.toHaveBeenCalled();
    if (stage === "load" || stage === "writeFile") expect(mock.exec).not.toHaveBeenCalled();
  },
);

it("fetches finite URL input into the VFS before executing", async () => {
  const bytes = new Uint8Array([4, 5]);
  const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }));
  vi.stubGlobal("fetch", fetchMock);
  const { process, exit } = spawn(["-i", "https://example.test/media", "pipe:1"]);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, null));
  expect(mock.writeFile).toHaveBeenCalledWith("url_0", bytes);
  expect(mock.exec).toHaveBeenCalledWith(["-i", "url_0", "output.raw"]);
  expect(await drain(process.stdout)).toEqual([7, 8]);
  expect(mock.terminate).toHaveBeenCalledTimes(1);
});

it("does not construct a worker when killed immediately without pipe input", async () => {
  const { process, exit } = spawn([]);
  process.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  expect(mock.constructed).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledExactlyOnceWith(null, "SIGTERM");
});
