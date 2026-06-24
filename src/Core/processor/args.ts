import type { InputSource } from "../../Types/index.js";
import type { ProcessorConfig } from "./config.js";

export function buildFullArgs(
  config: ProcessorConfig,
  extraGlobalArgs: string[],
  args: string[],
): string[] {
  const result: string[] = [];

  if (config.ffmpegLogLevel) {
    result.push("-loglevel", config.ffmpegLogLevel);
  }

  const hasHttpInputs = config.inputSources.some(
    (source) => source.type === "url" && source.url.startsWith("http"),
  );

  if (config.userAgent && hasHttpInputs) {
    result.push("-user_agent", config.userAgent);
  }

  result.push(...extraGlobalArgs);

  const sortedUrlSources = [...config.inputSources]
    .filter((s): s is Extract<InputSource, { type: "url" }> => s.type === "url")
    .sort((a, b) => a.index - b.index);

  for (const source of sortedUrlSources) {
    const globalHeaders = typeof config.headers === "object" ? config.headers : {};
    const finalHeaders = { ...globalHeaders, ...source.headers };

    if (Object.keys(finalHeaders).length > 0) {
      const headerStr = Object.entries(finalHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      result.push("-headers", headerStr);
    }

    result.push(
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-timeout",
      "10000000",
    );
    result.push("-i", source.url);
  }

  result.push(...args);
  return result;
}
