export declare class NormalizerEffect {
    enabled: boolean;
    private prevScale;
    private readonly TARGET_PEAK;
    private readonly MAX_GAIN;
    private readonly NOISE_FLOOR;
    private readonly RELEASE_SECONDS;
    constructor(enabled: boolean);
    set(enabled: boolean): void;
    calculateScale(samples: Int16Array, sampleRate?: number, channels?: number): number;
}
//# sourceMappingURL=normalizer.d.ts.map