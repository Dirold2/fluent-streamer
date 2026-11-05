function positiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
}

/** Compare a measured BPM with the original BPM after a speed change. */
export function compareScaledTempo(originalBpm, measuredBpm, speed) {
  positiveFinite(originalBpm, "originalBpm");
  positiveFinite(measuredBpm, "measuredBpm");
  positiveFinite(speed, "speed");
  const expected = originalBpm * speed;
  positiveFinite(expected, "scaled BPM");
  const ratio = measuredBpm / expected;
  const logRatio = Number.isFinite(ratio) && ratio > 0
    ? Math.log2(ratio)
    : Math.log2(measuredBpm) - Math.log2(expected);
  const octaveShift = Math.floor(logRatio + 0.5);
  const correctedRatio = 2 ** (logRatio - octaveShift);
  return {
    relativeError: Math.abs(ratio - 1),
    octaveShift: octaveShift === 0 ? 0 : octaveShift,
    familyErrorOctaves: Math.abs(logRatio - octaveShift),
    octaveCorrectedRelativeError: Math.abs(correctedRatio - 1),
  };
}

/** Match beats one-to-one, maximizing the count then minimizing total timing error. */
export function compareScaledBeats(originalTimesMs, measuredTimesMs, speed, toleranceMs = 30) {
  positiveFinite(speed, "speed");
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) throw new RangeError("toleranceMs must be non-negative and finite");
  const sorted = (times, scale) => times.map((time) => {
    if (!Number.isFinite(time) || !Number.isFinite(time / scale)) throw new RangeError("beat times must be finite");
    return time / scale;
  }).sort((a, b) => a - b);
  const expected = sorted(originalTimesMs, speed);
  const measured = sorted(measuredTimesMs, 1);
  // Sorted one-dimensional points admit an optimal non-crossing matching.
  // Two rows suffice because only the count and aggregate error are returned.
  let previous = Array.from({ length: measured.length + 1 }, () => ({ count: 0, error: 0 }));
  const better = (a, b) => a.count > b.count || (a.count === b.count && a.error <= b.error) ? a : b;
  for (const time of expected) {
    const current = [{ count: 0, error: 0 }];
    for (let j = 1; j <= measured.length; j++) {
      let best = better(previous[j], current[j - 1]);
      const error = Math.abs(time - measured[j - 1]);
      if (error <= toleranceMs) {
        const prior = previous[j - 1];
        best = better(best, { count: prior.count + 1, error: prior.error + error });
      }
      current.push(best);
    }
    previous = current;
  }
  const { count: matched, error } = previous[measured.length];
  return {
    matched,
    precision: measured.length ? matched / measured.length : 0,
    recall: expected.length ? matched / expected.length : 0,
    meanMatchedErrorMs: matched ? error / matched : null,
  };
}
