import type FluentStream from "./FluentStream.js";
export type PresetFn = (stream: FluentStream, options?: Record<string, unknown>) => void;
export declare function getPreset(name: string): PresetFn | undefined;
export declare function getPresetNames(): string[];
//# sourceMappingURL=presets.d.ts.map