import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CacheManager } from "hcacher";
import { HyperClient } from "hyperttp";

/** A bounded, per-stream compressed source cache. It never delays live decoding. */
export class SeekSourceCache {
  private readonly files = new CacheManager<string>({ maxSize: 1 });
  private readonly client = new HyperClient({ builtInPlugins: false });
  private readonly abort = new AbortController();
  private pending?: Promise<unknown>;
  private disposal?: Promise<void>;
  private directory?: string;
  private failed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly maxBytes: number,
  ) {}

  start(): void {
    this.pending = this.files.getOrSet(this.url, () => this.download())
      .catch(() => { this.failed = true; });
  }

  private async download(): Promise<string> {
    try {
      const response = await this.client.stream(
        this.url, { headers: this.headers }, this.abort.signal,
      );
      if (response.status !== 200 || !response.data) {
        throw new Error(`seek cache: HTTP ${response.status}`);
      }
      const contentLength = Object.entries(response.headers).find(
        ([key]) => key.toLowerCase() === "content-length",
      )?.[1];
      const size = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
      if (size > this.maxBytes) throw new Error("seek cache: source exceeds size limit");

      this.directory = await mkdtemp(join(tmpdir(), "fluent-seek-"));
      const path = join(this.directory, "source");
      let length = 0;
      const limited = async function* (source: AsyncIterable<Uint8Array>, maxBytes: number) {
        for await (const chunk of source) {
          length += chunk.byteLength;
          if (length > maxBytes) throw new Error("seek cache: source exceeds size limit");
          yield chunk;
        }
      };
      await pipeline(
        Readable.from(limited(response.data, this.maxBytes)),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal: this.abort.signal },
      );
      if (!length || (Number.isFinite(size) && size > 0 && length !== size)) {
        throw new Error("seek cache: incomplete source");
      }
      this.abort.signal.throwIfAborted();
      return path;
    } catch (error) {
      this.abort.abort();
      if (this.directory) {
        await rm(this.directory, { recursive: true, force: true });
        this.directory = undefined;
      }
      throw error;
    }
  }

  status(): "loading" | "ready" | "miss" {
    if (this.files.get(this.url)) return "ready";
    return this.failed ? "miss" : "loading";
  }

  /** Returns immediately on a miss; never wait for the network while seeking. */
  async localPath(): Promise<string | undefined> {
    return this.files.get(this.url);
  }

  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.abort.abort();
      this.files.clear();
      await this.pending;
      try {
        await this.client.destroy(false);
      } finally {
        if (this.directory) await rm(this.directory, { recursive: true, force: true });
        this.directory = undefined;
      }
    })();
    return this.disposal;
  }
}
