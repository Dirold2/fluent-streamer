export class ThrottleStream extends TransformStream<Uint8Array, Uint8Array> {
  private bytesPerSecond: number;
  private lastTime: number;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChunk: Uint8Array | null = null;
  private pendingController: TransformStreamDefaultController<Uint8Array> | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(bytesPerSecond: number) {
    super({
      transform: (chunk, controller) => {
        const now = performance.now();

        if (now - this.lastTime > 500) {
          this.lastTime = now;
        }

        const elapsed = now - this.lastTime;
        const allowedBytes = (elapsed / 1000) * this.bytesPerSecond;

        if (allowedBytes >= chunk.length) {
          controller.enqueue(chunk);
          this.lastTime += (chunk.length / this.bytesPerSecond) * 1000;
          return;
        }

        const delay = (chunk.length / this.bytesPerSecond) * 1000 - elapsed;
        return new Promise<void>((resolve) => {
          this._cancelPending();
          this.pendingChunk = chunk;
          this.pendingController = controller;
          this.pendingResolve = resolve;
          this.pendingTimer = setTimeout(() => {
            this._flushPending();
          }, Math.max(0, delay));
        });
      },
    });

    this.bytesPerSecond = bytesPerSecond;
    this.lastTime = performance.now();
  }

  public updateBitrate(bytesPerSecond: number): void {
    this.bytesPerSecond = Math.max(1000, bytesPerSecond);

    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;

      const now = performance.now();
      const elapsed = now - this.lastTime;
      const delay = Math.max(
        0,
        (this.pendingChunk!.length / this.bytesPerSecond) * 1000 - elapsed,
      );

      this.pendingTimer = setTimeout(() => {
        this._flushPending();
      }, delay);
    }
  }

  private _cancelPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private _flushPending(): void {
    this.pendingTimer = null;
    const resolve = this.pendingResolve!;
    const controller = this.pendingController!;
    const chunk = this.pendingChunk!;

    try {
      controller.enqueue(chunk);
    } catch {
      //
    }

    this.lastTime += (chunk.length / this.bytesPerSecond) * 1000;

    this.pendingChunk = null;
    this.pendingController = null;
    this.pendingResolve = null;

    resolve();
  }
}
