export type Runtime = "bun" | "node" | "deno" | "browser";

export interface FFmpegProcess {
  readonly pid: number | null;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: string): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  onError?(cb: (error: Error) => void): void;
}

export interface FFmpegRunner {
  spawn(ffmpegPath: string, args: string[]): FFmpegProcess;
  resolveBlobUrl?(blobUrl: string): Promise<ArrayBuffer>;
}

export type RunnerCtor = new () => FFmpegRunner;

export type RunnerDef = {
  readonly name: string;
  readonly runtime: readonly Runtime[];
  readonly path: string;
  readonly export: string;
  readonly priority: number;
};
