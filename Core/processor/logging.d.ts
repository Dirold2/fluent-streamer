import type { LogLevel, LoggingOptions } from "../../Types/index.js";
export type { LogLevel } from "../../Types/index.js";
/** Library implementation details are debug; info is reserved for meaningful app events. */
export declare const LOG_LEVELS: {
    readonly command: "debug";
    readonly audioConfig: "debug";
    readonly playbackComplete: "debug";
    readonly bitrate: "debug";
    readonly blobValidated: "debug";
    readonly effectChanged: "debug";
};
export declare function logMessage(config: LoggingOptions, level: LogLevel, message: string, meta?: Record<string, unknown>): void;
/** Full media URLs can contain credentials in both their path and query. */
export declare function redactMediaUrls(text: string): string;
//# sourceMappingURL=logging.d.ts.map