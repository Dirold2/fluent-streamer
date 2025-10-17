import { Transform } from "stream";

export interface AudioPluginOptions {
  sampleRate?: number;
  channels?: number;
}

/**
 * AudioPlugin produces a Node Transform stream that processes PCM s16le audio.
 * It may also expose a small control API for runtime adjustments.
 */
export interface AudioPlugin {
  /** Create the transform implementing the plugin DSP */
  createTransform(options: Required<AudioPluginOptions>): Transform;
}

/**
 * Simple gain plugin example: multiplies samples by a factor.
 */
export class GainPlugin implements AudioPlugin {
  constructor(private gain: number) {}

  setGain(g: number) {
    this.gain = g;
  }

  createTransform(options: Required<AudioPluginOptions>): Transform {
    const { channels } = options;
    const t = new Transform({
      transform: (
        chunk: Buffer,
        _enc: BufferEncoding,
        cb: (err?: Error | null, data?: Buffer) => void,
      ) => {
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
