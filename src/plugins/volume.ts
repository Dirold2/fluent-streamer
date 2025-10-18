import { AudioPlugin, AudioPluginBaseOptions } from "../../src/Core";
import { Transform } from "stream";

export interface VolumePluginOptions extends AudioPluginBaseOptions {
  start: number;
  end: number;
}

/**
 * Volume fade plugin.
 * Smoothly interpolates volume over frames.
 */
export class VolumeFaderPlugin implements AudioPlugin<VolumePluginOptions> {
  private options: Required<VolumePluginOptions>;

  constructor(options: VolumePluginOptions) {
    this.options = { sampleRate: 48000, channels: 2, ...options };
  }

  setOptions(options: Partial<VolumePluginOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): Required<VolumePluginOptions> {
    return this.options;
  }

  createTransform(options: Required<VolumePluginOptions>): Transform {
    const { channels, start, end } = options;
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
            const factor = start + ((end - start) * frame) / frameCount;
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

    t._start = start;
    t._end = end;
    return t;
  }
}
