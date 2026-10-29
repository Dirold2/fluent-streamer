export interface StableSection {
    startMs: number;
    endMs: number;
    validationStartMs: number;
    validationEndMs: number;
    bpm: number;
    beatPhaseMs: number;
    trainingCoverage: number;
    validationCoverage: number;
    trainingMatchedBeats: number;
    validationMatchedBeats: number;
    trainingErrorMs: number;
    validationErrorMs: number;
    phaseShiftMs: number;
}
/**
 * Find 20-second training windows, every 10 seconds, with a fully available
 * subsequent 10-second holdout. All intervals are half-open. Only observed
 * attacks are used, never tracked or synthesized beats.
 *
 * Period/phase selection and refinement use training onsets only. A globally
 * estimated seed is allowed, so holdout evidence is conditional on that seed,
 * not independent tempo validation. Harmonic ambiguity remains unresolved;
 * these beat grids do not identify downbeats. Phase is normalized from absolute
 * timestamps, not relative to the section start. Errors are RMS residuals and
 * phaseShiftMs is the signed holdout-minus-training median residual.
 *
 * Kept self-contained for native TypeScript workers.
 */
export declare function findStableSections(onsetsSeconds: number[], candidatePeriodSeconds: number, durationSeconds: number): StableSection[];
export interface BeatTrackingResult {
    beatTimesMs: number[];
    /** Fraction of returned beats with positive support in the truncated local kernel. */
    observedBeatFraction: number;
    /** Mean absolute deviation of adjacent beat intervals from the supplied period. */
    intervalErrorMs: number | null;
}
/**
 * Tracks a beat sequence at a supplied period; does not estimate tempo or downbeats.
 * Non-finite and negative envelope values are ignored. Peaks at or below 1e-12
 * are treated as silence; otherwise the envelope is normalized by its maximum.
 * Local support uses a Gaussian with sigma = 5% of the period, truncated at
 * ceil(3 sigma) frames. Weak endpoints (<10% of the strongest local score) are
 * trimmed, but unsupported interior beats may bridge missing onsets.
 *
 * Timing arguments must be finite, frame/period positive, and period >= 2 frames.
 * Work is O(N * min(N, period/frame)); no duration cap or input mutation is applied.
 */
export declare function trackBeatSequence(envelope: ArrayLike<number>, frameSeconds: number, periodSeconds: number, offsetSeconds?: number): BeatTrackingResult;
export interface GridStabilityWindow {
    startMs: number;
    endMs: number;
    onsetCount: number;
    matchedBeatCount: number;
    expectedBeatCount: number;
    coverage: number;
    residualMs: number | null;
    driftMsPerSecond: number | null;
}
export interface GridStability {
    windows: GridStabilityWindow[];
    supportedWindowFraction: number;
    maxAbsDriftMsPerSecond: number | null;
    phaseSpreadMs: number | null;
}
/**
 * Conditional inlier diagnostics, not proof of beat identity.
 * Windows and the duration are half-open. Grid beats are phase + n * period,
 * with n >= 0 and beat time >= 0. Residuals are onset time minus grid time;
 * drift regresses those residuals against grid beat time in seconds.
 */
export declare function evaluateGridStability(onsetsSeconds: number[], periodSeconds: number, phaseSeconds: number, durationSeconds: number): GridStability;
export interface TempoCandidate {
    bpm: number;
    strength: number;
}
export interface TempoWindow {
    startSeconds: number;
    candidates: TempoCandidate[];
}
/**
 * Aggregate correlation peaks without folding unrelated metric ratios.
 * Nearly equal octave hypotheses prefer the faster pulse as an explicit convention;
 * ambiguity remains reported, so this is not proof of musical beat identity.
 * Strengths must be in (0, 1]; invalid windows remain in the coverage denominator.
 * Each seed's 2.5% neighborhood gets only the strongest vote from each window.
 * The reported center and strength are medians of those votes, not all peaks.
 * Ambiguity is the best distinct competitor's summed strength / winning sum (0–1).
 * This does not compute or boost confidence; callers can use strength * agreement³ * coverage.
 */
export declare function selectTempoCandidate(windows: TempoWindow[]): {
    bpm: number;
    strength: number;
    agreement: number;
    coverage: number;
    ambiguity: number;
} | null;
export interface DjAnalysis {
    bpm: number | null;
    /** Best finite tempo hypothesis, even when it is not trusted for Automix. */
    bpmCandidate?: number;
    /** Pre-refinement hypothesis and competing tempo evidence for diagnostics. */
    tempoEstimateBpm?: number;
    tempoAmbiguity?: number;
    tempoWindows?: TempoWindow[];
    /** Per-section validation of the fitted grid; not calibrated probabilities. */
    gridStability?: GridStability;
    /** Diagnostic onset-driven sequence; may bridge missing attacks. Not downbeats. */
    beatTracking?: BeatTrackingResult;
    /** Local fits confirmed by subsequent observed attacks, conditional on tempo seed. */
    stableSections?: StableSection[];
    bpmConfidence: number;
    /** Beat grid offset in [0, 60000 / bpm), relative to the start of the input. */
    beatPhaseMs: number | null;
    beatPhaseConfidence: number;
    dropMs: number | null;
    dropConfidence: number;
    /** Number of spectral onset events used by the grid fit. */
    onsetCount?: number;
    /** Number of low-frequency kick/bass onset events. */
    bassOnsetCount?: number;
    /** Fraction of analysis windows that produced a tempo candidate. */
    tempoWindowCoverage?: number;
    /** Agreement of successful tempo windows with the selected tempo. */
    tempoWindowAgreement?: number;
    /** Fraction of expected beats supported by detected onsets. */
    beatCoverage?: number;
    /** RMS timing error of onsets accepted by the fitted grid, in ms. */
    beatGridErrorMs?: number;
    /** Fraction of spectral onsets accepted by the fitted grid. */
    phaseSupport?: number;
    /** Quality of accepted onset timing relative to the grid. */
    phaseFitQuality?: number;
    /** Number of onsets accepted by the fitted grid. */
    matchedOnsetCount?: number;
    /** Agreement between a bass-derived tempo and the spectral tempo. */
    bassTempoAgreement?: number;
    /** Repeated four-beat/downbeat evidence, when available. */
    downbeatConfidence?: number;
    analyzedDurationMs: number;
}
/** Mono signed 16-bit PCM. Invalid sample rates throw; short/unreliable audio abstains. */
export declare function analyzePcm(pcm: Int16Array, sampleRate: number): DjAnalysis;
//# sourceMappingURL=DjAnalysisCore.d.ts.map