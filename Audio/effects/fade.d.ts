export declare class FadeEffect {
    active: boolean;
    from: number;
    to: number;
    samplesTotal: number;
    samplesDone: number;
    start(targetVolume: number, durationMs: number, currentVolume: number, sampleRate: number): {
        from: number;
        to: number;
    };
    next(currentVolume: number): {
        volume: number;
        justFinished: boolean;
    };
}
//# sourceMappingURL=fade.d.ts.map