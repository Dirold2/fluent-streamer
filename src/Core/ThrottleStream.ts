import { Transform } from "stream";

export class ThrottleStream extends Transform {
  private bytesPerSecond: number;
  private lastTime: number = Date.now();
  private buffer: Buffer[] = [];
  private isThrottling: boolean = false;

  constructor(bytesPerSecond: number) {
    super();
    this.bytesPerSecond = bytesPerSecond;
  }

  public updateBitrate(bytesPerSecond: number) {
    this.bytesPerSecond = Math.max(1000, bytesPerSecond);
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ) {
    this.buffer.push(chunk);

    if (!this.isThrottling) {
      this.processBuffer();
    }

    callback();
  }

  private processBuffer() {
    if (this.buffer.length === 0) {
      this.isThrottling = false;
      return;
    }

    this.isThrottling = true;
    const chunk = this.buffer.shift()!;
    const now = Date.now();
    const elapsed = now - this.lastTime;

    // Рассчитываем, сколько байт мы могли бы отправить за прошедшее время
    const allowedBytes = (elapsed / 1000) * this.bytesPerSecond;

    if (elapsed === 0 || allowedBytes >= chunk.length) {
      // Если прошло достаточно времени, отправляем чанк немедленно
      this.push(chunk);
      this.lastTime = now;
      setImmediate(() => this.processBuffer());
    } else {
      // Рассчитываем необходимую задержку для соблюдения bitrate
      const delay = (chunk.length / this.bytesPerSecond) * 1000 - elapsed;

      setTimeout(
        () => {
          this.push(chunk);
          this.lastTime = Date.now();
          this.processBuffer();
        },
        Math.max(0, delay),
      );
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    // Обработать все оставшиеся чанки в буфере
    const flushAll = () => {
      if (this.buffer.length === 0) {
        callback();
      } else {
        const chunk = this.buffer.shift()!;
        this.push(chunk);
        setImmediate(flushAll);
      }
    };

    if (!this.isThrottling) {
      flushAll();
    } else {
      // Если throttling активен, подождём его завершения
      const checkThrottling = () => {
        if (!this.isThrottling) {
          flushAll();
        } else {
          setTimeout(checkThrottling, 10);
        }
      };
      checkThrottling();
    }
  }
}
