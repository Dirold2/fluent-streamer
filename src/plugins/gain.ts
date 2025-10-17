import { AudioPlugin, AudioPluginOptions } from "src/Core";
import { Transform } from "stream";

/**
 * Simple gain plugin example.
 * Multiplies each audio sample by a gain factor.
 */
export class GainPlugin implements AudioPlugin {
  constructor(private gain: number) {}

  /**
   * Sets the gain factor.
   * @param g - Gain multiplier
   */
  setGain(g: number) {
    this.gain = g;
  }

  /**
   * Creates a Node.js Transform stream that applies the gain to PCM s16le audio.
   * @param options - Audio options (sampleRate, channels)
   * @returns Transform stream that processes audio
   */
  createTransform(options: Required<AudioPluginOptions>): Transform {
    const { channels } = options;
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

    (t as any)._gain = this.gain;
    return t;
  }
}
