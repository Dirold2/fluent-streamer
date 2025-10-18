/**
 * Core public API: low-level `Processor` and fluent `SimpleFFmpeg` wrapper.
 */
export {
  Processor,
  FluentStream,
  PluginRegistry,
  FluentChain,
} from "./Core/index.js";

export { BassPlugin } from "./plugins/bass.js";
export { TreblePlugin } from "./plugins/treble.js";
export { CompressorPlugin } from "./plugins/compressor.js";
export { VolumeFaderPlugin } from "./plugins/volume.js";

export type { AudioPlugin, AudioPluginBaseOptions } from "./Core/Filters.js";

export {
  type SimpleFFmpegOptions,
  type FFmpegRunResult,
  type Logger,
  type FFmpegProgress,
} from "./Types/index.js";
