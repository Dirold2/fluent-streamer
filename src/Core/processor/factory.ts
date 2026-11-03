import type { ReplayableStreamSource } from "../../Types/index.js";

const stoppedError = () => new Error("FFmpeg input stopped");

/** Owns only one run's factory stream; never stores it in processor configuration. */
export class FactoryInput {
  private readonly controller = new AbortController();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private stopped = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      void promise.catch(() => {});
      throw stoppedError();
    }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(stoppedError());
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  async open(source: ReplayableStreamSource): Promise<void> {
    const opening = Promise.resolve()
      .then(() => {
        if (this.signal.aborted) throw stoppedError();
        return source.open(this.signal);
      })
      .then((stream) => {
        if (this.signal.aborted) {
          // An uncooperative open may finish after its run has already been retired.
          try {
            void stream.cancel().catch(() => {});
          } catch {}
          throw stoppedError();
        }
        this.reader = stream.getReader();
      });
    try {
      await this.wait(opening);
    } catch {
      this.dispose();
      throw new Error("Unable to open FFmpeg factory input");
    }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Source abort handlers must run before cancellation of their reader.
    this.controller.abort();
    const reader = this.reader;
    this.reader = undefined;
    if (reader) {
      const cancellation = reader.cancel();
      try {
        reader.releaseLock();
      } catch {}
      void cancellation
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {}
        });
    }
  }

  async pipeTo(stdin: WritableStream<Uint8Array>): Promise<void> {
    const reader = this.reader!;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let inputEnded = false;
    try {
      writer = stdin.getWriter();
      void writer.closed.then(
        () => {
          if (!inputEnded) this.dispose();
        },
        () => this.dispose(),
      );
      while (!this.signal.aborted) {
        await this.wait(writer.ready);
        const chunk = await this.wait(reader.read());
        if (chunk.done) {
          inputEnded = true;
          await this.wait(writer.close());
          return;
        }
        await this.wait(writer.write(chunk.value));
      }
    } catch {
      throw new Error("FFmpeg factory input transfer failed");
    } finally {
      this.dispose();
      if (writer) {
        void writer.abort().catch(() => {});
        try {
          writer.releaseLock();
        } catch {}
      }
    }
  }
}
