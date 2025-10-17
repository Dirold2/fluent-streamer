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
  /** Optional diagnostic name for logs and introspection */
  name?: string;
  /** Create the transform implementing the plugin DSP */
  createTransform(options: Required<AudioPluginOptions>): Transform;
}