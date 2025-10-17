/**
 * Core public API: low-level `Processor` and fluent `SimpleFFmpeg` wrapper.
 */
export { Processor, FluentStream, PluginRegistry, FluentChain } from "./Core";

export { BassPlugin } from "./plugins/bass";
export { TreblePlugin } from "./plugins/treble";
export { CompressorPlugin } from "./plugins/compressor";
export { VolumeFaderPlugin } from "./plugins/volume";

export type { AudioPlugin, AudioPluginOptions } from "./Core";

export { type SimpleFFmpegOptions, type FFmpegRunResult, type Logger, type FFmpegProgress } from "./Types";
