/** Stereo-preserving, frequency-selective center suppression; not vocal isolation. */
export declare class KaraokeEffect {
    private target;
    private wet;
    private readonly step;
    private readonly envelope;
    private readonly lower;
    private readonly upper;
    private lowerState;
    private upperState;
    private midEnergy;
    private sideEnergy;
    constructor(enabled?: boolean, sampleRate?: number);
    get enabled(): boolean;
    get active(): boolean;
    set(enabled: boolean): void;
    processStereo(left: number, right: number, channels: number): [number, number];
}
//# sourceMappingURL=karaoke.d.ts.map