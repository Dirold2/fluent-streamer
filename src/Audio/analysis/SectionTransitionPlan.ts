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

const fields = [
  "startMs",
  "endMs",
  "validationStartMs",
  "validationEndMs",
  "bpm",
  "beatPhaseMs",
  "trainingCoverage",
  "validationCoverage",
  "trainingMatchedBeats",
  "validationMatchedBeats",
  "trainingErrorMs",
  "validationErrorMs",
  "phaseShiftMs",
] as const;

function validSection(section: StableSection): boolean {
  if (!section || !fields.every((field) => Number.isFinite(section[field]))) return false;
  const period = 60000 / section.bpm;
  return (
    section.bpm >= 70 &&
    section.bpm <= 180 &&
    section.beatPhaseMs >= 0 &&
    section.beatPhaseMs < period &&
    section.startMs >= 0 &&
    section.startMs < section.endMs &&
    section.endMs === section.validationStartMs &&
    section.validationStartMs < section.validationEndMs &&
    section.trainingCoverage >= 0.5 &&
    section.trainingCoverage <= 1 &&
    section.validationCoverage >= 0.5 &&
    section.validationCoverage <= 1 &&
    Number.isInteger(section.trainingMatchedBeats) &&
    section.trainingMatchedBeats >= 20 &&
    Number.isInteger(section.validationMatchedBeats) &&
    section.validationMatchedBeats >= 8 &&
    section.trainingErrorMs >= 0 &&
    section.trainingErrorMs <= 0.05 * period &&
    section.validationErrorMs >= 0 &&
    section.validationErrorMs <= 0.05 * period &&
    Math.abs(section.phaseShiftMs) <= 0.05 * period
  );
}

function firstStart(section: StableSection, lower: number, period: number): number {
  return section.beatPhaseMs + Math.ceil((lower - section.beatPhaseMs) / period) * period;
}

// Resolve otherwise exact ties by section values, not array traversal order.
function compareSections(a: StableSection, b: StableSection): number {
  for (const field of fields) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

/**
 * Opt-in diagnostic preview only; not a production Automix plan. Uses only
 * HOLDOUT ranges, never training audio. Uses the production shorter-period / 16
 * error budget with a HEURISTIC RMS proxy, NOT a proven bound. Validation observes future
 * holdout data: this is an offline candidate, not a causal/live guarantee.
 * No time-stretch, phase correction, or subtraction of measured phase shifts.
 */
export function planSectionTransition(
  options: SectionTransitionOptions,
): SectionTransitionPlan | null {
  const {
    outgoingSections,
    incomingSections,
    outgoingPositionMs,
    maxOverlapMs = 8000,
    minOverlapBeats = 1,
  } = options;
  if (
    !Number.isFinite(outgoingPositionMs) ||
    outgoingPositionMs < 0 ||
    !Number.isFinite(maxOverlapMs) ||
    maxOverlapMs <= 0 ||
    maxOverlapMs > 16000 ||
    !Number.isInteger(minOverlapBeats) ||
    minOverlapBeats < 1
  ) {
    throw new RangeError("Invalid section transition position or overlap limits");
  }

  let best: SectionTransitionPlan | null = null;
  for (const [outgoingSectionIndex, outgoing] of outgoingSections.entries()) {
    if (!validSection(outgoing)) continue;
    const outPeriod = 60000 / outgoing.bpm;
    const earliest = firstStart(
      outgoing,
      Math.max(outgoingPositionMs, outgoing.validationStartMs),
      outPeriod,
    );
    for (const [incomingSectionIndex, incoming] of incomingSections.entries()) {
      if (!validSection(incoming)) continue;
      const inPeriod = 60000 / incoming.bpm;
      const incomingCueMs = firstStart(incoming, incoming.validationStartMs, inPeriod);
      const baseline =
        outgoing.validationErrorMs +
        incoming.validationErrorMs +
        Math.abs(outgoing.phaseShiftMs) +
        Math.abs(incoming.phaseShiftMs);
      const budget = Math.min(outPeriod, inPeriod) / 16;
      if (baseline > budget) continue;
      const rate = Math.abs(outPeriod / inPeriod - 1);
      const cap = Math.min(
        maxOverlapMs,
        outgoing.validationEndMs - earliest,
        incoming.validationEndMs - incomingCueMs,
        rate > 0 ? (budget - baseline) / rate : Infinity,
      );
      const beats = Math.floor(cap / outPeriod);
      if (beats < minOverlapBeats) continue;
      const overlapMs = beats * outPeriod;
      const outgoingStartMs =
        outgoing.beatPhaseMs +
        Math.floor((outgoing.validationEndMs - overlapMs - outgoing.beatPhaseMs) / outPeriod) *
          outPeriod;
      const estimatedErrorMs = baseline + rate * overlapMs;
      if (
        outgoingStartMs < earliest ||
        outgoingStartMs + overlapMs > outgoing.validationEndMs ||
        incomingCueMs + overlapMs > incoming.validationEndMs ||
        estimatedErrorMs > budget
      )
        continue;
      const candidate: SectionTransitionPlan = {
        outgoingStartMs,
        incomingCueMs,
        overlapMs,
        outgoingBpm: outgoing.bpm,
        incomingBpm: incoming.bpm,
        estimatedErrorMs,
        driftMsPerSecond: rate * 1000,
        outgoingSectionIndex,
        incomingSectionIndex,
        previewOnly: true,
      };
      if (
        !best ||
        candidate.overlapMs > best.overlapMs ||
        (candidate.overlapMs === best.overlapMs &&
          (candidate.estimatedErrorMs < best.estimatedErrorMs ||
            (candidate.estimatedErrorMs === best.estimatedErrorMs &&
              (candidate.outgoingStartMs > best.outgoingStartMs ||
                (candidate.outgoingStartMs === best.outgoingStartMs &&
                  (candidate.incomingCueMs < best.incomingCueMs ||
                    (candidate.incomingCueMs === best.incomingCueMs &&
                      (compareSections(outgoing, outgoingSections[best.outgoingSectionIndex]!) ||
                        compareSections(incoming, incomingSections[best.incomingSectionIndex]!)) <
                        0)))))))
      ) {
        best = candidate;
      }
    }
  }
  return best;
}
