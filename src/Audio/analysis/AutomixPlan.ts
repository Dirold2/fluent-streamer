import type { DjAnalysis } from "./DjAnalysis.js";

export type AutomixFallbackReason =
  | "unreliable-outgoing-grid"
  | "unreliable-incoming-grid"
  | "unreliable-both-grids"
  | "tempo-mismatch"
  | "insufficient-overlap"
  | "insufficient-grid-window"
  | "incoming-duration-limit"
  | "invalid-timing";

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
  /** Populated only for the opt-in late-window handoff; absolute outgoing source ms. */
  readonly outgoingHandoffDropMs?: number;
  /** Absolute source position of the additional outgoing analysis window. */
  readonly outgoingLateWindowStartMs?: number;
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
  reason: "energy-entry" | "tempo-phrase" | "crossfade" | "drop-handoff" | "seamless";
  /** Absolute outgoing track position, not a delay from now. */
  startMs: number;
  /** Outgoing beat period; null for an unquantized crossfade. */
  beatPeriodMs: number | null;
}

function scalar(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshot(analysis: DjAnalysis): AnalysisSnapshot {
  return {
    bpm: scalar(analysis.bpm),
    bpmCandidate: scalar(analysis.bpmCandidate),
    bpmConfidence: scalar(analysis.bpmConfidence),
    beatPhaseMs: scalar(analysis.beatPhaseMs),
    beatPhaseConfidence: scalar(analysis.beatPhaseConfidence),
    dropMs: scalar(analysis.dropMs),
    dropConfidence: scalar(analysis.dropConfidence),
    analyzedDurationMs: scalar(analysis.analyzedDurationMs),
    onsetCount: scalar(analysis.onsetCount),
    bassOnsetCount: scalar(analysis.bassOnsetCount),
    tempoWindowCoverage: scalar(analysis.tempoWindowCoverage),
    tempoWindowAgreement: scalar(analysis.tempoWindowAgreement),
    phaseSupport: scalar(analysis.phaseSupport),
    phaseFitQuality: scalar(analysis.phaseFitQuality),
    matchedOnsetCount: scalar(analysis.matchedOnsetCount),
    beatCoverage: scalar(analysis.beatCoverage),
    beatGridErrorMs: scalar(analysis.beatGridErrorMs),
    bassTempoAgreement: scalar(analysis.bassTempoAgreement),
    downbeatConfidence: scalar(analysis.downbeatConfidence),
    gridSupportedWindowFraction: scalar(analysis.gridStability?.supportedWindowFraction),
    gridMaxDriftMsPerSecond: scalar(analysis.gridStability?.maxAbsDriftMsPerSecond),
    gridPhaseSpreadMs: scalar(analysis.gridStability?.phaseSpreadMs),
  };
}

function gridIssues(analysis: DjAnalysis): string[] {
  const issues: string[] = [];
  const { bpm, bpmConfidence, beatPhaseMs, beatPhaseConfidence } = analysis;
  if (bpm == null) issues.push("missing-bpm");
  else if (!Number.isFinite(bpm)) issues.push("invalid-bpm");
  else if (bpm < 70 || bpm > 180) issues.push("bpm-out-of-range");
  for (const [name, value] of [
    ["bpm-confidence", bpmConfidence],
    ["beat-phase-confidence", beatPhaseConfidence],
  ] as const) {
    if (value == null) issues.push(`missing-${name}`);
    else if (!Number.isFinite(value)) issues.push(`invalid-${name}`);
    else if (value < 0 || value > 1) issues.push(`${name}-out-of-range`);
    else if (value < 0.65) issues.push(`${name}-low`);
  }
  if (beatPhaseMs == null) issues.push("missing-beat-phase");
  else if (!Number.isFinite(beatPhaseMs)) issues.push("invalid-beat-phase");
  else if (
    beatPhaseMs < 0 ||
    (bpm !== null && Number.isFinite(bpm) && bpm > 0 && beatPhaseMs >= 60000 / bpm)
  )
    issues.push("beat-phase-out-of-range");
  return issues;
}

function reliableGrid(analysis: DjAnalysis): boolean {
  const { bpm, bpmConfidence, beatPhaseMs, beatPhaseConfidence } = analysis;
  return (
    gridIssues(analysis).length === 0 &&
    bpm !== null &&
    Number.isFinite(bpm) &&
    bpm >= 70 &&
    bpm <= 180 &&
    Number.isFinite(bpmConfidence) &&
    bpmConfidence >= 0.65 &&
    bpmConfidence <= 1 &&
    Number.isFinite(beatPhaseConfidence) &&
    beatPhaseConfidence >= 0.65 &&
    beatPhaseConfidence <= 1 &&
    beatPhaseMs !== null &&
    Number.isFinite(beatPhaseMs) &&
    beatPhaseMs >= 0 &&
    beatPhaseMs < 60000 / bpm
  );
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
export function planAutomix(options: AutomixPlanOptions): AutomixPlan | null {
  const {
    outgoingAnalysis: outgoing,
    incomingAnalysis: incoming,
    outgoingPositionMs: position,
    outgoingRemainingMs: remaining,
    incomingDurationMs: duration,
    explicitDropMs,
  } = options;
  const finish = (
    result: AutomixPlan | null,
    fallbackReason: AutomixFallbackReason | null,
  ): AutomixPlan | null => {
    if (options.onDiagnostic) {
      const outBpm = scalar(outgoing.bpm);
      const inBpm = scalar(incoming.bpm);
      const tempoRatio =
        outBpm !== null && inBpm !== null && outBpm > 0 && inBpm > 0
          ? scalar(Math.max(outBpm, inBpm) / Math.min(outBpm, inBpm))
          : null;
      const diagnostic: AutomixDiagnostic = {
        outgoing: snapshot(outgoing),
        incoming: snapshot(incoming),
        outgoingGridIssues: gridIssues(outgoing),
        incomingGridIssues: gridIssues(incoming),
        fallbackReason,
        tempoRatio,
        octaveRelated: tempoRatio !== null && tempoRatio >= 1.85 && tempoRatio <= 2.15,
        timing: {
          outgoingPositionMs: scalar(position),
          outgoingRemainingMs: scalar(remaining),
          incomingDurationMs: scalar(duration),
          fallbackSeconds: scalar(options.fallbackSeconds),
          explicitDropMs: scalar(explicitDropMs),
        },
        outcome: result?.reason ?? null,
      };
      try {
        options.onDiagnostic(diagnostic);
      } catch {
        // Observability must not change timing advice or prevent a return.
      }
    }
    return result;
  };
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    !Number.isFinite(remaining) ||
    remaining <= 1000 ||
    !Number.isSafeInteger(Math.ceil(position + remaining)) ||
    (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))
  ) {
    return finish(null, "invalid-timing");
  }

  const availableMs = remaining - 1000;
  const capMs = Math.min(16000, availableMs, duration === undefined ? Infinity : duration / 4);
  const fallback =
    Number.isFinite(options.fallbackSeconds) && options.fallbackSeconds > 0
      ? options.fallbackSeconds
      : 8;
  const crossfade = (limitMs = Infinity): AutomixPlan => ({
    seconds: Math.min(fallback, capMs / 1000, limitMs / 1000),
    cueMs: 0,
    dropMs: null,
    reason: "crossfade",
    startMs: position,
    beatPeriodMs: null,
  });

  const outReliable = reliableGrid(outgoing);
  const inReliable = reliableGrid(incoming);
  if (!outReliable || !inReliable) {
    return finish(
      crossfade(),
      !outReliable && !inReliable
        ? "unreliable-both-grids"
        : !outReliable
          ? "unreliable-outgoing-grid"
          : "unreliable-incoming-grid",
    );
  }
  const outBpm = outgoing.bpm!;
  const inBpm = incoming.bpm!;
  // Symmetric, conservative tolerance: the faster tempo is at most 1.03x slower.
  if (!options.enableTempoMatch && Math.max(outBpm, inBpm) / Math.min(outBpm, inBpm) > 1.03) {
    return finish(crossfade(), "tempo-mismatch");
  }

  const period = 60000 / outBpm;
  const inPeriod = 60000 / inBpm;
  const relativeTempoDelta = Math.abs(1 - period / inPeriod);
  // Production reliability intentionally uses only the selected grid and its
  // confidence. Research diagnostics such as gridStability must not silently
  // change transition length; they are available to offline evaluators.
  const driftPerMs = relativeTempoDelta;
  const driftLimitMs = driftPerMs === 0 ? Infinity : Math.min(period, inPeriod) / 16 / driftPerMs;
  const barMs = period * 4;
  const quantizeOverlap = (limitMs: number): number => {
    // Preserve equal-tempo phrasing; unequal tempos may only afford a few beats.
    const quantum = driftPerMs > 0 && limitMs < barMs ? period : barMs;
    return Math.floor(limitMs / quantum) * quantum;
  };
  const shortFallback = (): AutomixPlan => crossfade(driftPerMs > 0 ? 1000 : Infinity);
  let overlapMs = quantizeOverlap(Math.min(16 * period, capMs, driftLimitMs));
  if (overlapMs <= 0) {
    return finish(
      shortFallback(),
      duration !== undefined && duration / 4 === capMs
        ? "incoming-duration-limit"
        : "insufficient-overlap",
    );
  }
  const phase = outgoing.beatPhaseMs!;
  const earliest = Math.max(position, position + availableMs - overlapMs);
  const startMs = phase + Math.ceil((earliest - phase) / period) * period;
  // Rounding the start forward must not consume the reserved tail.
  overlapMs = quantizeOverlap(Math.min(overlapMs, position + availableMs - startMs));
  if (overlapMs <= 0 || startMs < position) {
    return finish(shortFallback(), "insufficient-grid-window");
  }

  const validDrop = (value: number | null | undefined): value is number =>
    value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    (duration === undefined || value < duration);
  let dropMs: number | null = null;
  if (validDrop(explicitDropMs)) {
    dropMs = explicitDropMs;
  } else if (
    validDrop(incoming.dropMs) &&
    Number.isFinite(incoming.dropConfidence) &&
    incoming.dropConfidence >= 0.7 &&
    incoming.dropConfidence <= 1 &&
    Number.isFinite(incoming.analyzedDurationMs) &&
    incoming.dropMs < incoming.analyzedDurationMs
  ) {
    dropMs = incoming.dropMs;
  }

  const inPhase = incoming.beatPhaseMs!;
  let cueMs = inPhase;
  if (dropMs !== null) {
    // Prefer roughly one overlap of lead-in, snapping backward on the incoming
    // grid. Different periods / off-grid drops prevent exact drop alignment.
    cueMs = inPhase + Math.max(0, Math.floor((dropMs - overlapMs - inPhase) / inPeriod)) * inPeriod;
    if (cueMs >= dropMs || (duration !== undefined && cueMs + overlapMs > duration)) {
      dropMs = null;
      cueMs = inPhase;
    }
  }
  if (duration !== undefined && cueMs + overlapMs > duration) {
    return finish(shortFallback(), "incoming-duration-limit");
  }

  return finish(
    {
      seconds: overlapMs / 1000,
      cueMs,
      dropMs,
      reason: dropMs === null ? "tempo-phrase" : "energy-entry",
      startMs,
      beatPeriodMs: period,
    },
    null,
  );
}

/** Opt-in late-window advice. The outgoing analysis is relative to windowStartMs;
 * incoming analysis must start at zero. Only a measured, high-contrast rise on
 * both sides is eligible; energy rises are NOT proven musical downbeats.
 */
export interface DropHandoffOptions {
  outgoingLateAnalysis: DjAnalysis;
  incomingAnalysis: DjAnalysis;
  windowStartMs: number;
  outgoingDurationMs: number;
  outgoingPositionMs: number;
  incomingDurationMs: number;
  enableTempoMatch?: boolean;
  maxTempoChange?: number;
}

function firstConfidentDrop(analysis: DjAnalysis, minMs: number, maxMs: number): number | null {
  const candidates = analysis.dropCandidates ?? [
    { ms: analysis.dropMs, confidence: analysis.dropConfidence },
  ];
  const valid = candidates
    .filter(
      (candidate): candidate is { ms: number; confidence: number } =>
        candidate.ms !== null &&
        Number.isFinite(candidate.ms) &&
        candidate.ms >= minMs &&
        candidate.ms < maxMs &&
        candidate.ms < analysis.analyzedDurationMs &&
        Number.isFinite(candidate.confidence) &&
        candidate.confidence >= 0.7 &&
        candidate.confidence <= 1,
    )
    .sort((a, b) => a.ms - b.ms);
  return valid[0]?.ms ?? null;
}

/** Returns null rather than fabricating a drop when evidence/timing is insufficient. */
export function planDropHandoff(options: DropHandoffOptions): AutomixPlan | null {
  const {
    outgoingLateAnalysis: outgoing,
    incomingAnalysis: incoming,
    windowStartMs,
    outgoingDurationMs,
    outgoingPositionMs,
    incomingDurationMs,
  } = options;
  const maxChange = options.maxTempoChange ?? 0.08;
  if (
    ![windowStartMs, outgoingDurationMs, outgoingPositionMs, incomingDurationMs, maxChange].every(
      Number.isFinite,
    ) ||
    windowStartMs < 0 ||
    outgoingPositionMs < 0 ||
    outgoingDurationMs <= outgoingPositionMs + 1000 ||
    incomingDurationMs <= 0 ||
    maxChange < 0 ||
    maxChange >= 1 ||
    !reliableGrid(outgoing) ||
    !reliableGrid(incoming) ||
    !Number.isFinite(outgoing.analyzedDurationMs) ||
    !Number.isFinite(incoming.analyzedDurationMs) ||
    windowStartMs < outgoingDurationMs / 2
  )
    return null;

  // Select the earliest *confident* rise within each requested half. The old
  // dropMs field deliberately retains the strongest rise for existing callers.
  const outgoingDrop = firstConfidentDrop(
    outgoing,
    Math.max(
      0,
      outgoingDurationMs / 2 - windowStartMs,
      outgoingPositionMs + 1000 + (4 * 60000) / outgoing.bpm! - windowStartMs,
    ),
    outgoingDurationMs - windowStartMs - 1000,
  );
  const incomingDropMs = firstConfidentDrop(incoming, 0, incomingDurationMs / 2);
  if (outgoingDrop === null || incomingDropMs === null) return null;
  const outgoingDropMs = windowStartMs + outgoingDrop;
  // Never treat a late-window rise as the first-half event, or a late
  // incoming rise as the intended first drop. Also leave 1 s of source tail.
  if (outgoingDropMs > outgoingDurationMs - 1000 || incomingDropMs >= incomingDurationMs / 2)
    return null;

  const factor = options.enableTempoMatch ? outgoing.bpm! / incoming.bpm! : 1;
  if (
    !Number.isFinite(factor) ||
    Math.abs(factor - 1) > maxChange ||
    (!options.enableTempoMatch &&
      Math.max(outgoing.bpm!, incoming.bpm!) / Math.min(outgoing.bpm!, incoming.bpm!) > 1.03)
  )
    return null;
  const period = 60000 / outgoing.bpm!;
  const overlapMs =
    Math.floor(
      Math.min(
        16000,
        incomingDurationMs / 4,
        incomingDropMs / factor,
        outgoingDropMs - outgoingPositionMs - 1000,
      ) /
        (4 * period),
    ) *
    4 *
    period;
  if (overlapMs < 4 * period) return null;
  const startMs = outgoingDropMs - overlapMs;
  const cueMs = incomingDropMs - overlapMs * factor;
  if (
    cueMs < 0 ||
    startMs < outgoingPositionMs + 1000 ||
    cueMs + overlapMs * factor > incomingDurationMs
  )
    return null;
  const outgoingPhase =
    (((windowStartMs + outgoing.beatPhaseMs! - startMs) % period) + period) % period;
  const incomingPhase = ((((incoming.beatPhaseMs! - cueMs) / factor) % period) + period) % period;
  const phaseDelta = Math.abs(outgoingPhase - incomingPhase);
  const phaseError = Math.min(phaseDelta, period - phaseDelta);
  const drift = options.enableTempoMatch
    ? 0
    : Math.abs(1 - period / (60000 / incoming.bpm!)) * overlapMs;
  if (phaseError + drift > Math.min(period, 60000 / incoming.bpm!) / 16) return null;
  return {
    seconds: overlapMs / 1000,
    startMs,
    cueMs,
    dropMs: incomingDropMs,
    reason: "drop-handoff",
    beatPeriodMs: period,
  };
}
