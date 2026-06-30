import type { FFprobeResult } from "../Types/index.js";
interface ProbeOptions {
    ffprobePath?: string;
}
export declare function probe(input: string, options?: ProbeOptions): Promise<FFprobeResult>;
export declare function isFfprobeAvailable(): Promise<boolean>;
export {};
//# sourceMappingURL=probe.d.ts.map