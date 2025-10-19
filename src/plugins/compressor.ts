import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";

export interface CompressorPluginOptions extends AudioPluginBaseOptions {
  threshold: number;
  ratio: number;
}

/**
 * Simple dynamic range compressor.
 * Limits peaks above threshold.
 */
export class CompressorPlugin implements AudioPlugin<CompressorPluginOptions> {
  private options: Required<CompressorPluginOptions>;

  constructor(options: CompressorPluginOptions) {
    this.options = { sampleRate: 48000, channels: 2, ...options };
  }

  /** Динамически меняем настройки */
  setOptions(options: Partial<CompressorPluginOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Required<CompressorPluginOptions> {
    return this.options;
  }

  createTransform(options: Required<CompressorPluginOptions>): Transform {
    const { channels, threshold, ratio } = options;
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
              const abs = Math.abs(val);
              if (abs > threshold) {
                val = Math.sign(val) * (threshold + (abs - threshold) / ratio);
              }
              samples[idx] = Math.round(Math.max(-1, Math.min(1, val)) * 32767);
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _threshold: number; _ratio: number };

    t._threshold = threshold;
    t._ratio = ratio;
    return t;
  }
}
