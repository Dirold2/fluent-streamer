import type { Logger } from "../Types/index.js";

export const HUMANITY_HEADERS = Object.freeze({
  "X-Human-Intent": "true",
  "X-Request-Attention": "just-want-to-do-my-best",
  "User-Agent": "FluentStream/1.0 (friendly bot)",
});

export const DEFAULT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
};
