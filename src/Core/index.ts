/**
 * Core public API: low-level `Processor` and fluent `SimpleFFmpeg` wrapper.
 */
export { Processor } from "./Processor";
export { FluentStream } from "./FluentStream";
export {
  type AudioPlugin,
  type AudioPluginOptions,
} from "./Filters";
export { PluginRegistry } from "./PluginRegistry";
export { FluentChain } from "./FluentChain";