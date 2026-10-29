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

function normalizePhase(phase: number, period: number): number {
  const normalized = ((phase % period) + period) % period;
  return Math.min(normalized, period - normalized) < period * 1e-10 ? 0 : normalized;
}

// Half-open windows; absorb only floating-point noise at exact beat boundaries.
function firstBeat(time: number, phase: number, period: number): number {
  return Math.ceil((time - phase) / period - 1e-9);
}

function matchBeats(
  onsets: number[],
  phase: number,
  period: number,
  start: number,
  end: number,
): Map<number, number> {
  const first = firstBeat(start, phase, period);
  const last = firstBeat(end, phase, period);
  const matches = new Map<number, number>();
  for (const time of onsets) {
    const beat = Math.round((time - phase) / period);
    const residual = time - (phase + beat * period);
    if (beat < first || beat >= last || Math.abs(residual) > period * 0.1) continue;
    const previous = matches.get(beat);
    if (previous === undefined || Math.abs(residual) < Math.abs(previous)) {
      matches.set(beat, residual);
    }
  }
  return matches;
}

function metrics(onsets: number[], phase: number, period: number, start: number, end: number) {
  const residuals = [...matchBeats(onsets, phase, period, start, end).values()];
  residuals.sort((a, b) => a - b);
  const count = residuals.length;
  const expected = firstBeat(end, phase, period) - firstBeat(start, phase, period);
  const middle = Math.floor(count / 2);
  return {
    count,
    coverage: expected > 0 ? count / expected : 0,
    rms: count
      ? Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / count)
      : Infinity,
    median: count ? (residuals[middle]! + residuals[Math.floor((count - 1) / 2)]!) / 2 : NaN,
  };
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
export function findStableSections(
  onsetsSeconds: number[],
  candidatePeriodSeconds: number,
  durationSeconds: number,
): StableSection[] {
  if (!Number.isFinite(candidatePeriodSeconds) || candidatePeriodSeconds <= 0) {
    throw new RangeError("candidatePeriodSeconds must be finite and positive");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new RangeError("durationSeconds must be finite and nonnegative");
  }
  const onsets = [
    ...new Set(
      onsetsSeconds.filter((time) => Number.isFinite(time) && time >= 0 && time < durationSeconds),
    ),
  ].sort((a, b) => a - b);
  const sections: StableSection[] = [];
  if (!onsets.length) return sections;

  for (let start = 0; start + 30 <= durationSeconds; start += 10) {
    const end = start + 20;
    const training = onsets.filter((time) => time >= start && time < end);
    if (training.length < 20) continue;
    let period = candidatePeriodSeconds;
    let phase = 0;
    let bestSupport = -1;
    // Weighted circular histogram, like the core fitter. Each beat/bin votes
    // once, so repeated identical attacks cannot dominate the period search.
    for (let step = -100; step <= 100; step++) {
      const candidate = candidatePeriodSeconds * (1 + step * 0.00025);
      const histogram = new Float64Array(64);
      const votes = new Set<number>();
      for (const time of training) {
        const position = time / candidate;
        const bin = Math.min(63, Math.floor((position - Math.floor(position)) * 64));
        const vote = Math.floor(position) * 64 + bin;
        if (votes.has(vote)) continue;
        votes.add(vote);
        histogram[bin] = histogram[bin]! + 1;
      }
      for (let bin = 0; bin < 64; bin++) {
        let support = 0;
        for (let offset = -3; offset <= 3; offset++) {
          support += histogram[(bin + offset + 64) % 64]! * (1 - Math.abs(offset) / 4);
        }
        if (support > bestSupport) {
          bestSupport = support;
          period = candidate;
          phase = ((bin + 0.5) / 64) * candidate;
        }
      }
    }
    for (let iteration = 0; iteration < 3; iteration++) {
      const matches = matchBeats(training, phase, period, start, end);
      if (matches.size < 2) break;
      let meanBeat = 0;
      let meanTime = 0;
      for (const [beat, residual] of matches) {
        meanBeat += beat / matches.size;
        meanTime += (phase + beat * period + residual) / matches.size;
      }
      let numerator = 0;
      let denominator = 0;
      for (const [beat, residual] of matches) {
        numerator += (beat - meanBeat) * (phase + beat * period + residual - meanTime);
        denominator += (beat - meanBeat) ** 2;
      }
      const fitted = numerator / denominator;
      if (
        !Number.isFinite(fitted) ||
        fitted <= 0 ||
        Math.abs(fitted / candidatePeriodSeconds - 1) > 0.025 + 1e-12
      )
        break;
      period = fitted;
      phase = normalizePhase(meanTime - meanBeat * period, period);
    }
    const train = metrics(training, phase, period, start, end);
    if (train.count < 20 || train.coverage < 0.5 || train.rms > period * 0.05) continue;
    // Freeze the training fit before examining the holdout; no fallback grid
    // is selected if validation fails.
    const validation = metrics(
      onsets.filter((time) => time >= end && time < end + 10),
      phase,
      period,
      end,
      end + 10,
    );
    const shift = validation.median - train.median;
    if (
      validation.count < 8 ||
      validation.coverage < 0.5 ||
      validation.rms > period * 0.05 ||
      Math.abs(shift) > period * 0.05
    )
      continue;
    sections.push({
      startMs: start * 1000,
      endMs: end * 1000,
      validationStartMs: end * 1000,
      validationEndMs: (end + 10) * 1000,
      bpm: 60 / period,
      beatPhaseMs: normalizePhase(phase, period) * 1000,
      trainingCoverage: train.coverage,
      validationCoverage: validation.coverage,
      trainingMatchedBeats: train.count,
      validationMatchedBeats: validation.count,
      trainingErrorMs: train.rms * 1000,
      validationErrorMs: validation.rms * 1000,
      phaseShiftMs: shift * 1000,
    });
  }
  return sections;
}

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
export function trackBeatSequence(
  envelope: ArrayLike<number>,
  frameSeconds: number,
  periodSeconds: number,
  offsetSeconds = 0,
): BeatTrackingResult {
  if (
    !Number.isFinite(frameSeconds) ||
    frameSeconds <= 0 ||
    !Number.isFinite(periodSeconds) ||
    periodSeconds <= 0 ||
    periodSeconds / frameSeconds < 2 ||
    !Number.isFinite(offsetSeconds)
  ) {
    throw new RangeError(
      "Expected finite timing, positive frames, and a period of at least two frames",
    );
  }

  const empty = (): BeatTrackingResult => ({
    beatTimesMs: [],
    observedBeatFraction: 0,
    intervalErrorMs: null,
  });
  const length = envelope.length;
  if (length === 0) return empty();

  const normalized = new Float64Array(length);
  let peak = 0;
  for (let index = 0; index < length; index++) {
    const value = envelope[index]!;
    if (Number.isFinite(value) && value > 0) {
      normalized[index] = value;
      peak = Math.max(peak, value);
    }
  }
  if (peak <= 1e-12) return empty();
  for (let index = 0; index < length; index++) normalized[index] = normalized[index]! / peak;

  const periodFrames = periodSeconds / frameSeconds;
  const sigma = periodFrames * 0.05;
  const radius = Math.min(length - 1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(radius + 1);
  for (let distance = 0; distance <= radius; distance++) {
    kernel[distance] = Math.exp(-0.5 * (distance / sigma) ** 2);
  }
  const local = new Float64Array(length);
  let localPeak = 0;
  for (let index = 0; index < length; index++) {
    let score = 0;
    for (
      let source = Math.max(0, index - radius);
      source <= Math.min(length - 1, index + radius);
      source++
    ) {
      score += normalized[source]! * kernel[Math.abs(source - index)]!;
    }
    local[index] = score;
    localPeak = Math.max(localPeak, score);
  }
  // Keep the transition penalty independent of Gaussian width and envelope gain.
  for (let index = 0; index < length; index++) local[index] = local[index]! / localPeak;

  const minGap = Math.ceil(periodFrames * 0.5);
  const maxGap = Math.min(length - 1, Math.floor(periodFrames * 1.5));
  const penalties = new Float64Array(maxGap + 1);
  for (let gap = minGap; gap <= maxGap; gap++) {
    penalties[gap] = 100 * Math.log(gap / periodFrames) ** 2;
  }
  const cumulative = new Float64Array(length);
  const previous = new Int32Array(length).fill(-1);
  let endpoint = 0;
  for (let index = 0; index < length; index++) {
    // Zero is the restart score: a negative predecessor never forces a link.
    let best = 0;
    for (let gap = minGap; gap <= Math.min(maxGap, index); gap++) {
      const candidate = cumulative[index - gap]! - penalties[gap]!;
      if (candidate > best) {
        best = candidate;
        previous[index] = index - gap;
      }
    }
    cumulative[index] = local[index]! + best;
    if (cumulative[index]! > cumulative[endpoint]!) endpoint = index;
  }

  const beats: number[] = [];
  for (let index = endpoint; index >= 0; index = previous[index]!) beats.push(index);
  beats.reverse();
  let start = 0;
  let end = beats.length;
  while (start < end && local[beats[start]!]! < 0.1) start++;
  while (end > start && local[beats[end - 1]!]! < 0.1) end--;
  const retained = beats.slice(start, end);
  if (retained.length === 0) return empty();

  let observed = 0;
  let intervalError = 0;
  for (let index = 0; index < retained.length; index++) {
    if (local[retained[index]!]! > 0) observed++;
    if (index > 0) {
      intervalError += Math.abs(
        (retained[index]! - retained[index - 1]!) * frameSeconds - periodSeconds,
      );
    }
  }
  return {
    beatTimesMs: retained.map((index) => (offsetSeconds + index * frameSeconds) * 1000),
    observedBeatFraction: observed / retained.length,
    intervalErrorMs: retained.length > 1 ? (intervalError / (retained.length - 1)) * 1000 : null,
  };
}

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
export function evaluateGridStability(
  onsetsSeconds: number[],
  periodSeconds: number,
  phaseSeconds: number,
  durationSeconds: number,
): GridStability {
  if (
    !Number.isFinite(periodSeconds) ||
    periodSeconds <= 0 ||
    !Number.isFinite(phaseSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new RangeError(
      "Grid period and duration must be finite and positive; phase must be finite",
    );
  }

  const onsets = onsetsSeconds
    .filter((time) => Number.isFinite(time) && time >= 0 && time < durationSeconds)
    .sort((a, b) => a - b);
  const windows: GridStabilityWindow[] = [];
  const medians: number[] = [];
  let maxAbsDriftMsPerSecond: number | null = null;
  let onsetIndex = 0;

  // Check generated times too: division can round an exact boundary to either
  // side of an integer, but membership must agree with the actual grid time.
  function firstBeatAtOrAfter(time: number): number {
    let index = Math.max(0, Math.ceil((time - phaseSeconds) / periodSeconds));
    if (index > 0 && phaseSeconds + (index - 1) * periodSeconds >= time) index--;
    if (phaseSeconds + index * periodSeconds < time) index++;
    return index;
  }

  for (let windowIndex = 0; windowIndex < Math.ceil(durationSeconds / 10); windowIndex++) {
    const start = windowIndex * 10;
    const end = Math.min(start + 10, durationSeconds);
    const firstBeat = firstBeatAtOrAfter(start);
    const endBeat = firstBeatAtOrAfter(end);
    const expectedBeatCount = endBeat - firstBeat;
    const matches = new Map<number, number>();
    let onsetCount = 0;

    while (onsetIndex < onsets.length && onsets[onsetIndex]! < end) {
      const onset = onsets[onsetIndex++]!;
      onsetCount++;
      const beat = Math.round((onset - phaseSeconds) / periodSeconds);
      if (beat < firstBeat || beat >= endBeat) continue;
      const residual = onset - (phaseSeconds + beat * periodSeconds);
      // Permit only rounding error at the inclusive tolerance boundary.
      const roundingError =
        Number.EPSILON * Math.max(1, Math.abs(onset), Math.abs(phaseSeconds)) * 4;
      if (Math.abs(residual) > periodSeconds * 0.1 + roundingError) continue;
      const previous = matches.get(beat);
      if (previous === undefined || Math.abs(residual) < Math.abs(previous)) {
        matches.set(beat, residual);
      }
    }

    const matchedBeatCount = matches.size;
    const coverage = expectedBeatCount > 0 ? matchedBeatCount / expectedBeatCount : 0;
    let residualMs: number | null = null;
    let driftMsPerSecond: number | null = null;
    if (matchedBeatCount >= 4 && coverage >= 0.2) {
      const points = [...matches].map(([beat, residual]) => ({
        // Center within the window to avoid loss of precision on long tracks.
        time: phaseSeconds + beat * periodSeconds - start,
        residual: residual * 1000,
      }));
      const residuals = points.map((point) => point.residual).sort((a, b) => a - b);
      const middle = Math.floor(residuals.length / 2);
      residualMs =
        residuals.length % 2 === 0
          ? (residuals[middle - 1]! + residuals[middle]!) / 2
          : residuals[middle]!;
      const meanTime = points.reduce((sum, point) => sum + point.time, 0) / points.length;
      const meanResidual = points.reduce((sum, point) => sum + point.residual, 0) / points.length;
      let covariance = 0;
      let variance = 0;
      for (const point of points) {
        covariance += (point.time - meanTime) * (point.residual - meanResidual);
        variance += (point.time - meanTime) ** 2;
      }
      if (variance > 0) {
        driftMsPerSecond = covariance / variance;
        maxAbsDriftMsPerSecond = Math.max(maxAbsDriftMsPerSecond ?? 0, Math.abs(driftMsPerSecond));
      }
      medians.push(residualMs);
    }

    windows.push({
      startMs: start * 1000,
      endMs: end * 1000,
      onsetCount,
      matchedBeatCount,
      expectedBeatCount,
      coverage,
      residualMs,
      driftMsPerSecond,
    });
  }

  return {
    windows,
    supportedWindowFraction: medians.length / windows.length,
    maxAbsDriftMsPerSecond,
    phaseSpreadMs: medians.length > 0 ? Math.max(...medians) - Math.min(...medians) : null,
  };
}

export interface TempoCandidate {
  bpm: number;
  strength: number;
}

export interface TempoWindow {
  startSeconds: number;
  candidates: TempoCandidate[];
}

const RELATIVE_TOLERANCE = 0.025;

function nearby(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.min(a, b) <= RELATIVE_TOLERANCE;
}

function candidateMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? sorted[middle - 1]! + (sorted[middle]! - sorted[middle - 1]!) / 2
    : sorted[middle]!;
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
export function selectTempoCandidate(windows: TempoWindow[]): {
  bpm: number;
  strength: number;
  agreement: number;
  coverage: number;
  ambiguity: number;
} | null {
  const validWindows = windows.map((window) =>
    Number.isFinite(window.startSeconds) && window.startSeconds >= 0
      ? window.candidates
          .filter(
            (candidate) =>
              Number.isFinite(candidate.bpm) &&
              candidate.bpm > 0 &&
              Number.isFinite(candidate.strength) &&
              candidate.strength > 0 &&
              candidate.strength <= 1,
          )
          .sort((a, b) => b.strength - a.strength || a.bpm - b.bpm)
      : [],
  );
  const populatedWindows = validWindows.filter((candidates) => candidates.length > 0).length;
  if (populatedWindows === 0) return null;

  const seeds = [
    ...new Set(validWindows.flatMap((candidates) => candidates.map(({ bpm }) => bpm))),
  ];
  const hypotheses = seeds.map((seed) => {
    const votes: TempoCandidate[] = [];
    for (const candidates of validWindows) {
      const vote = candidates.find((candidate) => nearby(candidate.bpm, seed));
      if (vote) votes.push(vote);
    }
    // Sorting before summation makes floating-point scores independent of window order.
    const strengths = votes.map(({ strength }) => strength).sort((a, b) => a - b);
    return {
      bpm: candidateMedian(votes.map(({ bpm }) => bpm)),
      strength: candidateMedian(strengths),
      score: strengths.reduce((sum, strength) => sum + strength, 0),
      support: votes.length,
    };
  });
  hypotheses.sort((a, b) => b.score - a.score || b.support - a.support || a.bpm - b.bpm);

  let selected = hypotheses[0]!;
  const octave = hypotheses.find(
    (hypothesis) =>
      Math.abs(hypothesis.bpm / selected.bpm - 2) < 0.05 &&
      hypothesis.score >= selected.score * 0.98 &&
      hypothesis.support >= selected.support,
  );
  if (octave) selected = octave;
  // Many seeds describe the same local peak; they are not competing tempos.
  const competitor = hypotheses.find((hypothesis) => !nearby(hypothesis.bpm, selected.bpm));
  return {
    bpm: selected.bpm,
    strength: selected.strength,
    agreement: selected.support / populatedWindows,
    coverage: selected.support / windows.length,
    ambiguity: competitor ? Math.min(1, competitor.score / selected.score) : 0,
  };
}

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

const RATE = 4000;
const FFT_SIZE = 512;
const HOP = 80;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const median = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[middle]! + sorted[(sorted.length - 1) >> 1]!) / 2 : 0;
};

function fft(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j]!, real[i]!];
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    for (let offset = 0; offset < n; offset += size) {
      for (let j = 0; j < size / 2; j++) {
        const c = Math.cos(angle * j);
        const s = Math.sin(angle * j);
        const a = offset + j;
        const b = a + size / 2;
        const r = real[b]! * c - imaginary[b]! * s;
        const im = real[b]! * s + imaginary[b]! * c;
        real[b] = real[a]! - r;
        imaginary[b] = imaginary[a]! - im;
        real[a] = real[a]! + r;
        imaginary[a] = imaginary[a]! + im;
      }
    }
  }
}

/** Mono signed 16-bit PCM. Invalid sample rates throw; short/unreliable audio abstains. */
export function analyzePcm(pcm: Int16Array, sampleRate: number): DjAnalysis {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be finite and positive");
  }
  const length = Math.min(pcm.length, Math.floor(sampleRate * 90));
  const result: DjAnalysis = {
    bpm: null,
    bpmConfidence: 0,
    beatPhaseMs: null,
    beatPhaseConfidence: 0,
    dropMs: null,
    dropConfidence: 0,
    analyzedDurationMs: (length / sampleRate) * 1000,
  };
  if (length / sampleRate < 8) return result;

  // Area resampling also suppresses aliasing better than simply taking every Nth sample.
  const rate = Math.min(RATE, sampleRate);
  const count = Math.floor((length * rate) / sampleRate);
  if (count < FFT_SIZE + HOP) return result;
  const samples = new Float64Array(count);
  const ratio = sampleRate / rate;
  let mean = 0;
  for (let i = 0; i < count; i++) {
    const start = i * ratio;
    const end = Math.min(length, (i + 1) * ratio);
    let sum = 0;
    for (let j = Math.floor(start); j < end; j++) {
      sum += (pcm[j]! / 32768) * (Math.min(j + 1, end) - Math.max(j, start));
    }
    samples[i] = sum / (end - start);
    mean += samples[i]! / count;
  }
  let energy = 0;
  for (let i = 0; i < count; i++) {
    samples[i] = samples[i]! - mean;
    energy += samples[i]! ** 2;
  }
  if (energy / count < 1e-8) return result;

  // Drop detection is independent of tempo and phase. It must run before any
  // BPM/grid early return so an energy transition remains observable even when
  // the track has weak or ambiguous rhythm.
  const seconds = Math.floor(count / rate);
  const rms = Array.from({ length: seconds }, (_, second) => {
    let sum = 0;
    for (let i = Math.floor(second * rate); i < Math.floor((second + 1) * rate); i++)
      sum += samples[i]! ** 2;
    return Math.sqrt(sum / rate);
  });
  let bestDropContrast = 3;
  for (let second = 3; second < seconds - 2; second++) {
    const before = (rms[second - 1]! + rms[second - 2]! + rms[second - 3]!) / 3;
    const after = Math.min(rms[second]!, rms[second + 1]!, rms[second + 2]!);
    const contrast = after / Math.max(before, 0.0001);
    if (after > 0.01 && contrast > bestDropContrast) {
      bestDropContrast = contrast;
      result.dropMs = second * 1000;
      result.dropConfidence = clamp((contrast - 2) / 4);
    }
  }

  const window = Float64Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
  );
  const frames = Math.floor((count - FFT_SIZE) / HOP) + 1;
  const flux = new Float64Array(frames);
  const bassFlux = new Float64Array(frames);
  const previous = new Float64Array(FFT_SIZE / 2);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  for (let frame = 0; frame < frames; frame++) {
    for (let j = 0; j < FFT_SIZE; j++) real[j] = samples[frame * HOP + j]! * window[j]!;
    imaginary.fill(0);
    fft(real, imaginary);
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const magnitude = Math.log1p(Math.hypot(real[bin]!, imaginary[bin]!));
      const delta = Math.max(0, magnitude - previous[bin]!);
      if (frame > 0) {
        flux[frame] = flux[frame]! + delta;
        const frequency = (bin * rate) / FFT_SIZE;
        if (frequency >= 40 && frequency <= 180) bassFlux[frame] = bassFlux[frame]! + delta;
      }
      previous[bin] = magnitude;
    }
  }
  const fluxMean = flux.reduce((sum, value) => sum + value, 0) / frames;
  const fluxSd = Math.sqrt(flux.reduce((sum, value) => sum + (value - fluxMean) ** 2, 0) / frames);
  const bassMean = bassFlux.reduce((sum, value) => sum + value, 0) / frames;
  const bassSd = Math.sqrt(
    bassFlux.reduce((sum, value) => sum + (value - bassMean) ** 2, 0) / frames,
  );
  if (!fluxSd && !bassSd) return result;
  const envelope = Float64Array.from(flux, (value) => Math.max(0, value - fluxMean));
  const onsetThreshold = fluxMean + fluxSd * 0.45;
  const onsets: number[] = [];
  const bassOnsets: number[] = [];
  const bassThreshold = bassMean + bassSd * 0.3;
  for (let i = 1; i < frames - 1; i++) {
    if (
      fluxSd > 0 &&
      flux[i]! >= onsetThreshold &&
      flux[i]! > flux[i - 1]! &&
      flux[i]! >= flux[i + 1]!
    ) {
      const start = i * HOP;
      const end = Math.min(count, start + FFT_SIZE);
      const block = Math.max(1, Math.round(rate * 0.002));
      const energies: number[] = [];
      for (let j = start; j + block <= end; j += block) {
        let e = 0;
        for (let k = j; k < j + block; k++) e += samples[k]! ** 2;
        energies.push(e / block);
      }
      let rise = 0;
      let best = 0;
      for (let j = 1; j < energies.length; j++) {
        const delta = energies[j]! - energies[j - 1]!;
        if (delta > best) {
          best = delta;
          rise = j;
        }
      }
      const time = (start + rise * block) / rate;
      if (!onsets.length || time - onsets[onsets.length - 1]! > 0.18) onsets.push(time);
    }
    if (
      bassSd > 0 &&
      bassFlux[i]! >= bassThreshold &&
      bassFlux[i]! > bassFlux[i - 1]! &&
      bassFlux[i]! >= bassFlux[i + 1]!
    ) {
      const time = (i * HOP) / rate;
      if (!bassOnsets.length || time - bassOnsets[bassOnsets.length - 1]! > 0.18)
        bassOnsets.push(time);
    }
  }

  if (onsets.length + bassOnsets.length < 8) return result;
  result.onsetCount = onsets.length;
  result.bassOnsetCount = bassOnsets.length;

  const frameSeconds = HOP / rate;
  const windowFrames = Math.min(frames, Math.round(20 / frameSeconds));
  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= frames; start += Math.round(10 / frameSeconds))
    starts.push(start);
  if (starts[starts.length - 1] !== frames - windowFrames) starts.push(frames - windowFrames);
  const tempoWindows: TempoWindow[] = [];
  for (const start of starts) {
    const scores: Array<{ lag: number; score: number }> = [];
    let localMean = 0;
    for (let i = start; i < start + windowFrames; i++) localMean += envelope[i]! / windowFrames;
    for (
      let lag = Math.floor(60 / 180 / frameSeconds) - 1;
      lag <= Math.ceil(60 / 70 / frameSeconds) + 1;
      lag++
    ) {
      let cross = 0,
        a = 0,
        b = 0;
      for (let i = start; i < start + windowFrames - lag; i++) {
        const x = envelope[i]! - localMean,
          y = envelope[i + lag]! - localMean;
        cross += x * y;
        a += x * x;
        b += y * y;
      }
      scores.push({ lag, score: a && b ? cross / Math.sqrt(a * b) : 0 });
    }
    const candidates = scores
      .flatMap((peak, index) => {
        const left = scores[index - 1]?.score ?? 0;
        const right = scores[index + 1]?.score ?? 0;
        if (peak.score < 0.2 || peak.score <= left || peak.score < right) return [];
        // Interpolate the correlation maximum rather than replacing its period
        // with arbitrary near-beat onset gaps (which can bias syncopated music).
        const curvature = left - 2 * peak.score + right;
        const shift =
          index > 0 && index < scores.length - 1 && curvature < -1e-9
            ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature))
            : 0;
        const bpm = 60 / ((peak.lag + shift) * frameSeconds);
        return bpm >= 70 / 1.025 && bpm <= 180 * 1.025
          ? [{ bpm, strength: clamp(peak.score) }]
          : [];
      })
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);
    tempoWindows.push({ startSeconds: start * frameSeconds, candidates });
  }
  const selectedTempo = selectTempoCandidate(tempoWindows);
  if (!selectedTempo) return result;
  result.tempoWindows = tempoWindows;
  result.tempoEstimateBpm = selectedTempo.bpm;
  result.tempoAmbiguity = selectedTempo.ambiguity;
  result.stableSections = findStableSections(
    onsets,
    60 / selectedTempo.bpm,
    result.analyzedDurationMs / 1000,
  );
  const tempoEstimate = selectedTempo.bpm;
  let bpm = tempoEstimate;
  // Bass/kick is intentionally a corroborating signal only. It must not
  // nudge the primary spectral tempo: a kick envelope can contain omissions,
  // double hits, or syncopated accents that would bias the beat period.
  const bassIntervals: number[] = [];
  for (let i = 1; i < bassOnsets.length; i++) {
    const interval = bassOnsets[i]! - bassOnsets[i - 1]!;
    if (interval >= (60 / 180) * 0.7 && interval <= (60 / 70) * 1.3) bassIntervals.push(interval);
  }
  const bassBpm = bassIntervals.length >= 4 ? 60 / median(bassIntervals) : null;
  const bassTempoAgreement =
    bassBpm !== null && bpm > 0 ? 1 - Math.min(1, Math.abs(bassBpm - bpm) / bpm / 0.08) : 0;
  const windowCoverage =
    tempoWindows.filter((window) => window.candidates.length > 0).length / starts.length;
  const agreement = selectedTempo.agreement;
  result.tempoWindowCoverage = windowCoverage;
  result.tempoWindowAgreement = agreement;
  const strength = selectedTempo.strength;
  let period = 60 / bpm;
  // Search period as well as phase: a sub-millisecond period error accumulates
  // across a 90-second excerpt. Offbeat percussion must not cancel the beat grid.
  const bins = 64;
  let phase = 0;
  let bestSupport = 0;
  const initialPeriod = period;
  for (let step = -250; step <= 250; step++) {
    const candidate = initialPeriod * (1 + step * 0.0001);
    const histogram = new Float64Array(bins);
    for (const time of onsets) {
      const bin = Math.floor(((time / candidate) % 1) * bins);
      histogram[bin] = histogram[bin]! + 1;
    }
    for (let bin = 0; bin < bins; bin++) {
      let support = 0;
      for (let offset = -3; offset <= 3; offset++) {
        support += histogram[(bin + offset + bins) % bins]! * (1 - Math.abs(offset) / 4);
      }
      if (support > bestSupport) {
        bestSupport = support;
        period = candidate;
        phase = ((bin + 0.5) / bins) * candidate;
      }
    }
  }
  // Refine only attacks close to the winning grid, excluding subdivisions.
  for (let iteration = 0; iteration < 3; iteration++) {
    const points = onsets
      .map((time) => ({ beat: Math.round((time - phase) / period), time }))
      .filter((p) => Math.abs(p.time - phase - p.beat * period) < period * 0.08);
    if (points.length < 8) break;
    const mx = points.reduce((sum, p) => sum + p.beat, 0) / points.length;
    const my = points.reduce((sum, p) => sum + p.time, 0) / points.length;
    let numerator = 0,
      denominator = 0;
    for (const p of points) {
      numerator += (p.beat - mx) * (p.time - my);
      denominator += (p.beat - mx) ** 2;
    }
    const fitted = numerator / denominator;
    if (!(fitted > 0) || Math.abs(fitted - initialPeriod) / initialPeriod > 0.025) break;
    period = fitted;
    phase = (((my - mx * period) % period) + period) % period;
  }
  // The onset timestamps are quantized by the analysis hop. Fit the period
  // against the whole accepted sequence once more; this removes the small
  // nearest-lag bias, updating the phase consistently with the fitted period.
  const fitPoints = onsets
    .map((time) => ({ beat: Math.round((time - phase) / period), time }))
    .filter((point) => Math.abs(point.time - (phase + point.beat * period)) <= period * 0.1);
  if (fitPoints.length >= 8) {
    const meanBeat = fitPoints.reduce((sum, point) => sum + point.beat, 0) / fitPoints.length;
    const meanTime = fitPoints.reduce((sum, point) => sum + point.time, 0) / fitPoints.length;
    let numerator = 0;
    let denominator = 0;
    for (const point of fitPoints) {
      numerator += (point.beat - meanBeat) * (point.time - meanTime);
      denominator += (point.beat - meanBeat) ** 2;
    }
    const fittedPeriod = numerator / denominator;
    if (
      Number.isFinite(fittedPeriod) &&
      fittedPeriod > 0 &&
      Number.isFinite(meanTime) &&
      Number.isFinite(meanBeat) &&
      Math.abs(fittedPeriod - period) / period <= 0.02
    ) {
      const fittedPhase = meanTime - meanBeat * fittedPeriod;
      if (Number.isFinite(fittedPhase)) {
        period = fittedPeriod;
        phase = ((fittedPhase % period) + period) % period;
      }
    }
  }
  bpm = 60 / period;
  // Numerical fits at exact supported boundaries may differ by sub-cent BPM.
  if (Math.abs(bpm - 70) < 0.005) bpm = 70;
  if (Math.abs(bpm - 180) < 0.005) bpm = 180;

  // Evaluate the already-fitted beat grid instead of shifting its phase again.
  const durationSeconds = result.analyzedDurationMs / 1000;
  const expectedBeats = Math.max(1, Math.floor(durationSeconds / period));
  const tolerance = period * 0.1;
  const matchedBeatIndices = new Set<number>();
  let matchedOnsets = 0;
  let squaredResidual = 0;
  for (const time of onsets) {
    const beatIndex = Math.round((time - phase) / period);
    const beatTime = phase + beatIndex * period;
    const error = time - beatTime;
    if (Math.abs(error) > tolerance) continue;
    matchedOnsets++;
    squaredResidual += error * error;
    if (beatTime >= 0 && beatTime < durationSeconds) matchedBeatIndices.add(beatIndex);
  }
  const phaseSupport = onsets.length > 0 ? matchedOnsets / onsets.length : 0;
  const beatCoverage = clamp(matchedBeatIndices.size / expectedBeats);
  const normalizedRmsError =
    matchedOnsets > 0 ? Math.sqrt(squaredResidual / matchedOnsets) / tolerance : 1;
  const fitQuality = clamp(1 - normalizedRmsError);
  const phaseConcentration = clamp((phaseSupport - 0.15) / 0.45);
  const phaseConfidence = clamp(
    phaseConcentration * Math.min(1, beatCoverage / 0.2) * (0.7 + 0.3 * fitQuality),
  );
  // Use calibrated onset timestamps, not STFT frame indices: the current
  // non-centered spectral frontend does not timestamp attacks at frame starts.
  const beatEnvelope = new Float64Array(Math.ceil(durationSeconds / frameSeconds));
  for (const time of onsets) {
    const index = Math.round(time / frameSeconds);
    if (index < beatEnvelope.length) beatEnvelope[index] = 1;
  }
  result.beatTracking = trackBeatSequence(beatEnvelope, frameSeconds, period);
  result.gridStability = evaluateGridStability(onsets, period, phase, durationSeconds);
  result.phaseSupport = phaseSupport;
  result.phaseFitQuality = fitQuality;
  result.matchedOnsetCount = matchedOnsets;
  result.beatCoverage = beatCoverage;
  result.beatGridErrorMs =
    matchedOnsets > 0 ? Math.sqrt(squaredResidual / matchedOnsets) * 1000 : undefined;
  result.bassTempoAgreement = bassTempoAgreement;
  // A true downbeat classifier is not part of this pass; do not publish bass
  // tempo agreement under a misleading downbeat name.
  result.downbeatConfidence = undefined;
  result.beatPhaseConfidence = phaseConfidence;

  const confidence = clamp(strength * agreement ** 3 * windowCoverage);
  result.bpmConfidence = confidence;

  if (Number.isFinite(bpm) && bpm >= 70 && bpm <= 180) {
    result.bpmCandidate = Math.round(bpm * 100) / 100;
  }

  if (confidence < 0.35 || agreement < 0.75 || bpm < 70 || bpm > 180) return result;
  result.bpm = result.bpmCandidate ?? null;
  result.beatPhaseConfidence = phaseConfidence;
  if (phaseConfidence < 0.35) return result;
  result.beatPhaseMs = (((phase % period) + period) % period) * 1000;
  return result;
}
