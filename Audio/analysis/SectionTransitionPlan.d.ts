import type { StableSection } from "./DjAnalysisCore.js";
export interface SectionTransitionOptions {
    outgoingSections: readonly StableSection[];
    incomingSections: readonly StableSection[];
    outgoingPositionMs: number;
    maxOverlapMs?: number;
    minOverlapBeats?: number;
}
export interface SectionTransitionPlan {
    outgoingStartMs: number;
    incomingCueMs: number;
    overlapMs: number;
    outgoingBpm: number;
    incomingBpm: number;
    estimatedErrorMs: number;
    driftMsPerSecond: number;
    outgoingSectionIndex: number;
    incomingSectionIndex: number;
    previewOnly: true;
}
/**
 * Opt-in diagnostic preview only; not a production Automix plan. Uses only
 * HOLDOUT ranges, never training audio. Uses the production shorter-period / 16
 * error budget with a HEURISTIC RMS proxy, NOT a proven bound. Validation observes future
 * holdout data: this is an offline candidate, not a causal/live guarantee.
 * No time-stretch, phase correction, or subtraction of measured phase shifts.
 */
export declare function planSectionTransition(options: SectionTransitionOptions): SectionTransitionPlan | null;
//# sourceMappingURL=SectionTransitionPlan.d.ts.map