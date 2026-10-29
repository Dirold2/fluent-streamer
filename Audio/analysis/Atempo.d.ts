export interface AtempoPlan {
    factor: number;
    filters: string[];
    filter: string;
}
/** Build a pitch-preserving FFmpeg atempo chain. factor > 1 is faster. */
export declare function buildAtempoPlan(factor: number): AtempoPlan;
/** Commands use input seconds; integrate speed over output time for each step. */
export declare function buildReturningAtempo(factor: number, overlapSeconds: number, returnSeconds?: number): string;
//# sourceMappingURL=Atempo.d.ts.map