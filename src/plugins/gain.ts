import { AudioPlugin, AudioPluginBaseOptions } from "src/Types/index.js";
import { Transform } from "stream";

export interface GainPluginOptions extends AudioPluginBaseOptions {
  gain: number;
}

/**
 * Simple gain plugin example.
 * Multiplies each audio sample by a gain factor.
 */
export class GainPlugin implements AudioPlugin<GainPluginOptions> {
  private options: Required<GainPluginOptions>;

  constructor(options: GainPluginOptions) {
    this.options = { sampleRate: 48000, channels: 2, ...options };
  }

  setOptions(options: Partial<GainPluginOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Required<GainPluginOptions> {
    return this.options;
  }

  /**
   * Creates a Node.js Transform stream that applies the gain to PCM s16le audio.
   * @param options - Audio options (sampleRate, channels)
   * @returns Transform stream that processes audio
   */
  createTransform(options: Required<GainPluginOptions>): Transform {
    const opts = options ?? this.options;
    const { channels, gain } = opts;
    const t = new Transform({
      transform: (chunk: Buffer, _enc: BufferEncoding, cb) => {
        try {
          const samples = new Int16Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.length / 2,
          );
          for (let i = 0; i < samples.length; i += channels) {
            for (let c = 0; c < channels; c++) {
              const idx = i + c;
              const val = samples[idx] / 32768;
              const scaled = Math.max(-1, Math.min(1, val * (t as any)._gain));
              samples[idx] = Math.round(scaled * 32767);
            }
          }
          cb(null, chunk);
        } catch (e) {
          cb(e as Error);
        }
      },
    }) as Transform & { _gain: number };

    (t as any)._gain = gain;
    return t;
  }
}
