export interface AtempoPlan {
  factor: number;
  filters: string[];
  filter: string;
}

/** Build a pitch-preserving FFmpeg atempo chain. factor > 1 is faster. */
export function buildAtempoPlan(factor: number): AtempoPlan {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError("tempo factor must be finite and positive");
  const filters: string[] = [];
  let remaining = factor;
  // FFmpeg accepts each atempo stage in [0.5, 2]. Splitting avoids relying on
  // implementation-specific behavior outside that documented range.
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-12) filters.push(`atempo=${format(remaining)}`);
  return { factor, filters, filter: filters.length ? filters.join(",") : "anull" };
}

/** Piecewise source/output clock matching the command schedule used by FFmpeg. */
export function createReturningTempoTimeline(
  factor: number,
  overlapSeconds: number,
  returnSeconds = 4,
) {
  if (
    !Number.isFinite(factor) ||
    factor < 0.5 ||
    factor > 2 ||
    !Number.isFinite(overlapSeconds) ||
    overlapSeconds < 0 ||
    !Number.isFinite(returnSeconds) ||
    returnSeconds <= 0
  )
    throw new RangeError("Invalid returning tempo timing or factor");
  const steps = Math.max(1, Math.ceil(returnSeconds / 0.1));
  const dt = returnSeconds / steps;
  const segments = [{ output: 0, source: 0, speed: factor }];
  let output = overlapSeconds;
  let source = factor * overlapSeconds;
  let speed = factor;
  const commands: { time: number; speed: number }[] = [];
  for (let step = 1; step <= steps; step++) {
    output += dt;
    source += speed * dt;
    speed = factor + ((1 - factor) * step) / steps;
    segments.push({ output, source, speed });
    commands.push({ time: source, speed });
  }
  return {
    commands,
    toSource(outputSeconds: number): number {
      let segment = segments[0]!;
      for (const candidate of segments) {
        if (candidate.output > outputSeconds) break;
        segment = candidate;
      }
      return segment.source + (outputSeconds - segment.output) * segment.speed;
    },
    toOutput(sourceSeconds: number): number {
      let segment = segments[0]!;
      for (const candidate of segments) {
        if (candidate.source > sourceSeconds) break;
        segment = candidate;
      }
      return segment.output + (sourceSeconds - segment.source) / segment.speed;
    },
  };
}

/** Commands use input seconds; integrate speed over output time for each step. */
export function buildReturningAtempo(
  factor: number,
  overlapSeconds: number,
  returnSeconds = 4,
): string {
  const timeline = createReturningTempoTimeline(factor, overlapSeconds, returnSeconds);
  if (factor === 1) return "anull";
  const commands = timeline.commands.map(
    ({ time, speed }) => `${format(time)} atempo@automix tempo ${format(speed)}`,
  );
  return `asetpts=N/SR/TB,asendcmd=c='${commands.join(";")}',atempo@automix=${format(factor)}`;
}

function format(value: number): string {
  return Number(value.toFixed(12)).toString();
}
