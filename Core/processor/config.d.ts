import type { AudioProcessingOptions, InputSource, ProcessorOptions } from "../../Types/index.js";
export type ProcessorConfig = {
    ffmpegPath: string;
    failFast: boolean;
    extraGlobalArgs: string[];
    loggerTag: string;
    inputStreams: Array<{
        stream: ReadableStream<Uint8Array>;
        index: number;
    }>;
    onBeforeChildProcessSpawn?: (ffmpegPath: string, args: string[]) => void;
    stderrLogHandler?: (chunk: string) => void;
    executionId: string;
    wallTimeLimit: number;
    timeout: number;
    maxStderrBuffer: number;
    enableProgressTracking: boolean;
    logger: NonNullable<ProcessorOptions["logger"]>;
    verbose: boolean;
    debug: boolean;
    abortSignal?: AbortSignal;
    headers: Record<string, string> | string;
    userAgent: string;
    disableThrottling: boolean;
    ffmpegLogLevel: NonNullable<ProcessorOptions["ffmpegLogLevel"]>;
    useAudioProcessor: boolean;
    inputSources: InputSource[];
    audioProcessorOptions: AudioProcessingOptions;
    autoDrainOutput: boolean;
};
export declare function buildProcessorConfig(options?: ProcessorOptions): ProcessorConfig;
//# sourceMappingURL=config.d.ts.map