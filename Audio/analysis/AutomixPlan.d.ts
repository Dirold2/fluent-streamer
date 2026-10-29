import type { DjAnalysis } from "./DjAnalysis.js";
export type AutomixFallbackReason = "unreliable-outgoing-grid" | "unreliable-incoming-grid" | "unreliable-both-grids" | "tempo-mismatch" | "insufficient-overlap" | "insufficient-grid-window" | "incoming-duration-limit" | "invalid-timing";
/** Finite input scalars only; missing and non-finite values are represented by null. */
type AnalysisSnapshot = Readonly<{
    bpm: number | null;
    bpmCandidate: number | null;
    bpmConfidence: number | null;
    beatPhaseMs: number | null;
    beatPhaseConfidence: number | null;
    dropMs: number | null;
    dropConfidence: number | null;
    analyzedDurationMs: number | null;
    onsetCount: number | null;
    bassOnsetCount: number | null;
    tempoWindowCoverage: number | null;
    tempoWindowAgreement: number | null;
    phaseSupport: number | null;
    phaseFitQuality: number | null;
    matchedOnsetCount: number | null;
    beatCoverage: number | null;
    beatGridErrorMs: number | null;
    bassTempoAgreement: number | null;
    downbeatConfidence: number | null;
    gridSupportedWindowFraction: number | null;
    gridMaxDriftMsPerSecond: number | null;
    gridPhaseSpreadMs: number | null;
}>;
export interface AutomixDiagnostic {
    readonly outgoing: AnalysisSnapshot;
    readonly incoming: AnalysisSnapshot;
    readonly outgoingGridIssues: readonly string[];
    readonly incomingGridIssues: readonly string[];
    readonly fallbackReason: AutomixFallbackReason | null;
    /** Faster / slower positive finite BPM, even when the grids are unreliable. */
    readonly tempoRatio: number | null;
    readonly octaveRelated: boolean;
    readonly timing: Readonly<{
        outgoingPositionMs: number | null;
        outgoingRemainingMs: number | null;
        incomingDurationMs: number | null;
        fallbackSeconds: number | null;
        explicitDropMs: number | null;
    }>;
    readonly outcome: AutomixPlan["reason"] | null;
}
export interface AutomixPlanOptions {
    outgoingAnalysis: DjAnalysis;
    incomingAnalysis: DjAnalysis;
    outgoingPositionMs: number;
    outgoingRemainingMs: number;
    incomingDurationMs?: number;
    fallbackSeconds: number;
    explicitDropMs?: number;
    enableTempoMatch?: boolean;
    maxTempoChange?: number;
    onDiagnostic?: (diagnostic: AutomixDiagnostic) => void;
}
export interface AutomixPlan {
    seconds: number;
    cueMs: number;
    dropMs: number | null;
    reason: "energy-entry" | "tempo-phrase" | "crossfade";
    /** Absolute outgoing track position, not a delay from now. */
    startMs: number;
    /** Outgoing beat period; null for an unquantized crossfade. */
    beatPeriodMs: number | null;
}
/**
 * Pure timing advice: never seeks, changes playback speed, or applies effects.
 * Four beats are treated as a bar; phase alone cannot identify musical downbeats.
 * Grids may be extrapolated beyond the analyzer's (at most 90 s) input window.
 * This assumes stable tempo: confidence describes that window, not the rest of
 * the track. Unequal-tempo overlaps limit estimated drift to 1/16 of the shorter
 * beat, not measured phase error. This cannot guarantee audible beat alignment
 * and is not maintained beat sync.
 * Invalid outgoing times or a supplied invalid incoming duration return null.
 * Invalid fallback lengths use 8 seconds. All overlaps reserve 1 s outgoing
 * and, when duration is known, use at most a quarter of the incoming track.
 */
export declare function planAutomix(options: AutomixPlanOptions): AutomixPlan | null;
export {};
//# sourceMappingURL=AutomixPlan.d.ts.map