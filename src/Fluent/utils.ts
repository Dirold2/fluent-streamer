import type { InputSource } from "../Types/index.js";

export function getStackTrace(skip = 2): string {
  const stack = new Error().stack;
  return stack
    ? stack
        .split("\n")
        .slice(skip)
        .filter((l) => !l.includes("node:internal"))
        .join("\n")
    : "";
}

export function countInputs(
  args: string[],
  inputStreams: Array<{ stream: ReadableStream<Uint8Array>; index: number }>,
  inputSources: InputSource[],
): {
  streams: number;
  stringInputs: number;
  urlInputs: number;
  total: number;
} {
  let stringInputs = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") stringInputs++;
  }
  const urlInputs = inputSources.filter((s) => s.type === "url").length;
  return {
    streams: inputStreams.length,
    stringInputs,
    urlInputs,
    total: stringInputs + inputStreams.length + urlInputs,
  };
}

export function summarizeInputs(
  args: string[],
  _inputStreams: Array<{ stream: ReadableStream<Uint8Array>; index: number }>,
  complexFilters: string[],
  inputSources: InputSource[],
): {
  stringInputs: string[];
  urlInputs: string[];
  pipeStreams: string[];
  complexFilters: string[];
} {
  const result: {
    stringInputs: string[];
    urlInputs: string[];
    pipeStreams: string[];
    complexFilters: string[];
  } = {
    stringInputs: [],
    urlInputs: [],
    pipeStreams: [],
    complexFilters: [...complexFilters],
  };

  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-i") {
      const next = args[i + 1]!;
      if (/^pipe:\d+$/.test(next)) {
        result.pipeStreams.push(next);
      } else {
        result.stringInputs.push(next);
      }
    }
  }

  for (const source of inputSources) {
    if (source.type === "url") {
      result.urlInputs.push(source.url);
    }
  }

  return result;
}
