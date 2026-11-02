/** Full media URLs can contain credentials in both their path and query. */
export function redactMediaUrls(text: string): string {
  const scope = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(name: string): string | undefined } };
  };
  let enabled: string | undefined;
  try {
    enabled = scope.process?.env?.FLUENT_STREAMER_LOG_URLS ??
      scope.Deno?.env?.get("FLUENT_STREAMER_LOG_URLS");
  } catch {
    // Deno may deny environment access. Keep the safe default.
  }
  if (enabled === "1") return text;
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}
