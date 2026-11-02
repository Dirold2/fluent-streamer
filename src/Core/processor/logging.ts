import type { LogLevel, LoggingOptions } from "../../Types/index.js";

export type { LogLevel } from "../../Types/index.js";

/** Library implementation details are debug; info is reserved for meaningful app events. */
export const LOG_LEVELS = {
  command: "debug",
  audioConfig: "debug",
  playbackComplete: "debug",
  bitrate: "debug",
  blobValidated: "debug",
  effectChanged: "debug",
} as const satisfies Record<string, LogLevel>;

export function logMessage(
  config: LoggingOptions,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const safeMessage = redactMediaUrls(message);
  if (config.logger) {
    if (meta === undefined) config.logger[level](safeMessage);
    else config.logger[level](safeMessage, meta);
    return;
  }
  if (!config.verbose && level !== "error") return;
  if (meta === undefined) console[level](safeMessage);
  else console[level](safeMessage, meta);
}

/** Full media URLs can contain credentials in both their path and query. */
export function redactMediaUrls(text: string): string {
  const scope = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(name: string): string | undefined } };
  };
  let enabled: string | undefined;
  try {
    enabled =
      scope.process?.env?.FLUENT_STREAMER_LOG_URLS ??
      scope.Deno?.env?.get("FLUENT_STREAMER_LOG_URLS");
  } catch {
    // Deno may deny environment access. Keep the safe default.
  }
  if (enabled === "1") return text;
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}
