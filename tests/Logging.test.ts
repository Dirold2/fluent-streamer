import { afterEach, expect, it, vi } from "vitest";
import { Processor } from "../src/Core/Processor.js";
import { logMessage, redactMediaUrls } from "../src/Core/processor/logging.js";
import { buildProcessExitError } from "../src/Core/processor/stderr.js";

const url = "https://user:password@cdn.example/music/ysign1=secret,ts=123/file.mp3?token=private";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("hides complete media URLs including path signatures, credentials and query by default", () => {
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", undefined);
  expect(redactMediaUrls(`-ss 12 -i ${url} pipe:1`)).toBe("-ss 12 -i [redacted-url] pipe:1");
  expect(redactMediaUrls("HTTP://cdn.example/secret https://other.example/key")).toBe(
    "[redacted-url] [redacted-url]",
  );
  expect(redactMediaUrls("-i /tmp/source.mp3 pipe:1")).toBe("-i /tmp/source.mp3 pipe:1");
});

it("requires explicit opt-in for sensitive URLs", () => {
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", "true");
  expect(redactMediaUrls(url)).toBe("[redacted-url]");
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", "1");
  expect(redactMediaUrls(url)).toBe(url);
});

it("redacts only the logged command, not the executable arguments", () => {
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", "0");
  const info = vi.fn();
  const debug = vi.fn();
  const processor = new Processor({
    verbose: true,
    logger: {
      info,
      debug,
      playerError: vi.fn(),
      child() {
        return this;
      },
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  const args = ["-i", url, "pipe:1"];
  (processor as any)._logSpawnDetails(args);
  expect(debug.mock.calls[0]![0]).toContain("-i [redacted-url] pipe:1");
  expect(args).toEqual(["-i", url, "pipe:1"]);
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", "1");
  (processor as any)._logSpawnDetails(args);
  expect(debug.mock.calls[2]![0]).toContain(url);
  expect(info).not.toHaveBeenCalled();
});

it("redacts stderr before truncation so a partial signature cannot escape in errors", () => {
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", undefined);
  expect(
    buildProcessExitError(1, null, `Cannot open ${url}${"x".repeat(5000)}\nHTTP 403`).message,
  ).toBe("FFmpeg exited with code 1.\nLast stderr output:\nCannot open [redacted-url]\nHTTP 403");
  vi.stubEnv("FLUENT_STREAMER_LOG_URLS", "1");
  expect(buildProcessExitError(1, null, url).message).toContain(url);
});

it("forwards all levels to an object logger with its receiver and metadata intact", () => {
  const meta = { playerId: "test" };
  const logger = {
    debug: vi.fn(function (this: unknown) {
      expect(this).toBe(logger);
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    playerError: vi.fn(),
    child() {
      return this;
    },
  };
  for (const level of ["debug", "info", "warn", "error"] as const) {
    logMessage({ logger, verbose: false }, level, "message", meta);
    expect(logger[level]).toHaveBeenCalledWith("message", meta);
  }
});

it("gates only console fallback and always reports errors", () => {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const level of ["debug", "info", "warn", "error"] as const)
    logMessage({ verbose: false }, level, "quiet");
  expect(debug).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("quiet");
  logMessage({ verbose: true }, "debug", "enabled", { value: 1 });
  expect(debug).toHaveBeenCalledWith("enabled", { value: 1 });
});
