const VALID_CURVES = [
  "tri",
  "qsin",
  "esin",
  "hsin",
  "log",
  "ipar",
  "qua",
  "cub",
  "squ",
  "cbr",
  "par",
  "exp",
  "iqsin",
  "ihsin",
  "dese",
  "desi",
  "losi",
  "nofade",
] as const;

export function buildAcrossfadeFilter(
  opts: {
    inputs?: number;
    nb_samples?: number;
    duration?: number | string;
    curve1?: string;
    curve2?: string;
    inputLabels?: string[];
    outputLabel?: string;
  } = {},
): { filter: string; outputLabel?: string } {
  const inputs = opts.inputs ?? 2;
  const duration = opts.duration ?? 3;
  const curve1 = opts.curve1 ?? "tri";
  const curve2 = opts.curve2 ?? "tri";
  const outputLabel = opts.outputLabel ?? "acf";

  if (!VALID_CURVES.includes(curve1 as (typeof VALID_CURVES)[number])) {
    throw new Error(`Invalid curve1: ${curve1}. Must be one of: ${VALID_CURVES.join(", ")}`);
  }
  if (!VALID_CURVES.includes(curve2 as (typeof VALID_CURVES)[number])) {
    throw new Error(`Invalid curve2: ${curve2}. Must be one of: ${VALID_CURVES.join(", ")}`);
  }

  const params: string[] = [`d=${duration}`, `c1=${curve1}`, `c2=${curve2}`];
  if (opts.nb_samples !== undefined) {
    params.push(`ns=${opts.nb_samples}`);
  }

  const paramStr = params.join(":");

  if (inputs === 2) {
    const in0 = opts.inputLabels?.[0] ?? "0:a";
    const in1 = opts.inputLabels?.[1] ?? "1:a";
    return {
      filter: `[${in0}][${in1}]acrossfade=${paramStr}[${outputLabel}]`,
      outputLabel,
    };
  }

  const filterParts: string[] = [];
  let prevLabel = "";

  for (let i = 1; i < inputs; i++) {
    const in0Label = i === 1 ? (opts.inputLabels?.[0] ?? "0:a") : prevLabel;
    const in1Label = opts.inputLabels?.[i] ?? `${i}:a`;
    const outLabel = i === inputs - 1 ? outputLabel : `acf_${i}`;

    filterParts.push(`[${in0Label}][${in1Label}]acrossfade=${paramStr}[${outLabel}]`);
    prevLabel = outLabel;
  }

  return { filter: filterParts.join(";"), outputLabel };
}
