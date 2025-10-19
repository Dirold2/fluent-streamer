import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";

export interface TreblePluginOptions extends AudioPluginBaseOptions {
  treble: number;
}

export class TreblePlugin implements AudioPlugin<TreblePluginOptions> {
  private options: Required<TreblePluginOptions>;

  constructor(options: TreblePluginOptions) {
    this.options = { sampleRate: 48000, channels: 2, ...options };
  }

  setOptions(options: Partial<TreblePluginOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Required<TreblePluginOptions> {
    return this.options;
  }

  createTransform(options: Required<TreblePluginOptions>): Transform {
    const { channels, treble } = options;
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
              val = val * (1 + treble * 0.3);
              samples[idx] = Math.round(Math.max(-1, Math.min(1, val)) * 32767);
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _treble: number };

    t._treble = treble;
    return t;
  }
}
