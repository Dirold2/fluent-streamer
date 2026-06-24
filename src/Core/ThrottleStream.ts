export class ThrottleStream extends TransformStream<Uint8Array, Uint8Array> {
  private bytesPerSecond: number;
  private lastTime: number = Date.now();

  constructor(bytesPerSecond: number) {
    super({
      transform: (chunk, controller) => {
        const now = Date.now();

        if (now - this.lastTime > 1000) {
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
          setTimeout(
            () => {
              try {
                controller.enqueue(chunk);
              } catch {
                //
              }
              this.lastTime += (chunk.length / this.bytesPerSecond) * 1000;
              resolve();
            },
            Math.max(0, delay),
          );
        });
      },
    });

    this.bytesPerSecond = bytesPerSecond;
  }

  public updateBitrate(bytesPerSecond: number) {
    this.bytesPerSecond = Math.max(1000, bytesPerSecond);
  }
}
