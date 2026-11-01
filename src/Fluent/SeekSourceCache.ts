import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheManager } from "hcacher";

/** A bounded, per-stream compressed source cache. It never delays live decoding. */
export class SeekSourceCache {
  private readonly bytes = new CacheManager<Uint8Array>({ maxSize: 1 });
  private readonly abort = new AbortController();
  private pending?: Promise<unknown>;
  private directory?: string;
  private file?: string;
  private failed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly maxBytes: number,
  ) {}

  start(): void {
    this.pending = this.bytes.getOrSet(this.url, async () => {
      const response = await fetch(this.url, {
        headers: this.headers,
        signal: this.abort.signal,
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error(`seek cache: HTTP ${response.status}`);
      }
      const size = Number(response.headers.get("content-length"));
      if (size > this.maxBytes) {
        await response.body.cancel();
        throw new Error("seek cache: source exceeds size limit");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > this.maxBytes) {
            await reader.cancel();
            throw new Error("seek cache: source exceeds size limit");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!length || (Number.isFinite(size) && size > 0 && length !== size)) {
        throw new Error("seek cache: incomplete source");
      }
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return data;
    }).catch(() => { this.failed = true; });
  }

  status(): "loading" | "ready" | "miss" {
    if (this.file || this.bytes.get(this.url)) return "ready";
    return this.failed ? "miss" : "loading";
  }

  /** Returns immediately on a miss; never wait for the network while seeking. */
  async localPath(): Promise<string | undefined> {
    if (this.file) return this.file;
    const data = this.bytes.get(this.url);
    if (!data) return undefined;
    this.directory = await mkdtemp(join(tmpdir(), "fluent-seek-"));
    try {
      const path = join(this.directory, "source");
      await writeFile(path, data, { mode: 0o600 });
      this.file = path;
      this.bytes.clear();
      return path;
    } catch (error) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    this.bytes.clear();
    await this.pending;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.file = undefined;
  }
}
