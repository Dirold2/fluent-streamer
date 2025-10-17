import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";

/**
 * Volume fade plugin.
 * Smoothly interpolates volume over frames.
 */
export class VolumeFaderPlugin implements AudioPlugin {
  constructor(
    private start = 1,
    private end = 1,
  ) {}

  setFade(start: number, end: number) {
    this.start = start;
    this.end = end;
  }

  createTransform(options: Required<AudioPluginOptions>): Transform {
    const { channels } = options;
    const t = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        try {
          const samples = new Int16Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.length / 2,
          );
          const frameCount = samples.length / channels;
          for (let frame = 0; frame < frameCount; frame++) {
            const factor =
              this.start + ((this.end - this.start) * frame) / frameCount;
            for (let c = 0; c < channels; c++) {
              const idx = frame * channels + c;
              let val = samples[idx] / 32768;
              samples[idx] = Math.round(
                Math.max(-1, Math.min(1, val * factor)) * 32767,
              );
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _start: number; _end: number };

    t._start = this.start;
    t._end = this.end;
    return t;
  }
}
