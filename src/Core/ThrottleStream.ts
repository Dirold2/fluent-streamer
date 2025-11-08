import { Transform } from "stream";

export class ThrottleStream extends Transform {
  private bytesPerSecond: number;
  private lastTime: number = Date.now();

  constructor(bytesPerSecond: number) {
    super();
    this.bytesPerSecond = bytesPerSecond;
  }

  _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    const now = Date.now();
    const elapsed = now - this.lastTime;
    const allowedBytes = (elapsed / 1000) * this.bytesPerSecond;

    if (allowedBytes >= chunk.length) {
      this.push(chunk);
      this.lastTime = now;
      callback();
    } else {
      let i = 0;
      const pushChunk = () => {
        if (i >= chunk.length) {
          this.lastTime = Date.now();
          callback();
          return;
        }
        const end = Math.min(i + allowedBytes, chunk.length);
        this.push(chunk.slice(i, end));
        i = end;
        setTimeout(pushChunk, 20);
      };
      pushChunk();
    }
  }
}
