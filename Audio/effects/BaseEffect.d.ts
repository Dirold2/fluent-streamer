export interface AudioEffect {
    readonly name: string;
    isActive(): boolean;
    process(samples: Float64Array, channels: number, frames: number): void;
    reset(): void;
}
//# sourceMappingURL=BaseEffect.d.ts.map