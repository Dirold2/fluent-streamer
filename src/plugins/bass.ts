import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";

export interface BassPluginOptions extends AudioPluginBaseOptions {
  bass: number;
}

/**
 * Bass boost plugin.
 * Усиление басов на PCM аудио.
 */
export class BassPlugin implements AudioPlugin<BassPluginOptions> {
  private options: Required<BassPluginOptions>;

  constructor(options: BassPluginOptions) {
    this.options = { sampleRate: 48000, channels: 2, ...options };
  }

  /** Динамически меняем настройки */
  setOptions(options: Partial<BassPluginOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Required<BassPluginOptions> {
    return this.options;
  }

  createTransform(options?: Required<BassPluginOptions>): Transform {
    const opts = options ?? this.options;
    const { channels, bass } = opts;

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
              val = val * (1 + bass * 0.5);
              samples[idx] = Math.round(Math.max(-1, Math.min(1, val)) * 32767);
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _bass: number };

    t._bass = bass;
    return t;
  }
}
