import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";

export class TreblePlugin implements AudioPlugin {
  constructor(private treble: number) {}

  setTreble(t: number) {
    this.treble = t;
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
          for (let i = 0; i < samples.length; i += channels) {
            for (let c = 0; c < channels; c++) {
              const idx = i + c;
              let val = samples[idx] / 32768;
              // Simple treble boost simulation (linear for demo)
              val = val * (1 + this.treble * 0.3);
              samples[idx] = Math.round(Math.max(-1, Math.min(1, val)) * 32767);
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _treble: number };

    t._treble = this.treble;
    return t;
  }
}
