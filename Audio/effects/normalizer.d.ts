export declare class NormalizerEffect {
    enabled: boolean;
    private prevScale;
    private readonly SMOOTHING;
    constructor(enabled: boolean);
    set(enabled: boolean): void;
    calculateScale(samples: Int16Array): number;
}
//# sourceMappingURL=normalizer.d.ts.map