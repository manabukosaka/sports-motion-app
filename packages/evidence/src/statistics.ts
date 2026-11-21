import type { KinematicMetrics } from "@sports-motion/contracts";

type NormalizedWaveform = KinematicMetrics["normalized_waveforms"][number];

function requireFinite(...values: number[]) {
  if (!values.every(Number.isFinite)) {
    throw new RangeError("Expected finite statistics");
  }
}

function normalPercentile(zScore: number) {
  const z = Math.abs(zScore);
  const squared = z * z;
  const density = Math.exp(-squared / 2) / Math.sqrt(2 * Math.PI);
  if (z >= 5) {
    // Continued fraction for the normal tail avoids cancellation near 0%.
    let correction = 0;
    for (let order = 24; order >= 1; order -= 1) {
      correction = order / (z + correction);
    }
    const tail = density / (z + correction);
    return 100 * (zScore < 0 ? tail : 1 - tail);
  }
  // Abramowitz and Stegun 7.1.6, with z = sqrt(2) * erf's argument.
  let term = z;
  let sum = term;
  for (let denominator = 3; ; denominator += 2) {
    term *= squared / denominator;
    const next = sum + term;
    if (sum === next) {
      break;
    }
    sum = next;
  }
  const area = density * sum;
  const percentile = 100 * (0.5 + Math.sign(zScore) * area);
  return Math.min(100, Math.max(0, percentile));
}

export function evaluateMeanSd(observed: number, { mean, sd }: { mean: number; sd: number }) {
  requireFinite(observed, mean, sd);
  if (sd <= 0) {
    throw new RangeError("Standard deviation must be positive");
  }
  const difference = observed - mean;
  const zScore = Number.isFinite(difference) ? difference / sd : observed / sd - mean / sd;
  requireFinite(zScore);
  return {
    zScore,
    percentile: normalPercentile(zScore),
    band: zScore < -1 ? "below_typical" : zScore > 1 ? "above_typical" : "within_typical",
  } as const;
}

export function evaluateMedianIqr(
  observed: number,
  { median, q1, q3 }: { median: number; q1: number; q3: number },
) {
  requireFinite(observed, median, q1, q3);
  if (q1 > median || median > q3) {
    throw new RangeError("Expected q1 <= median <= q3");
  }
  const band = observed < q1 ? "below_q1" : observed > q3 ? "above_q3" : "within_iqr";
  const iqr = q3 - q1;
  if (iqr === 0) {
    return { band, normalizedOffset: null } as const;
  }
  const difference = observed - median;
  const normalizedOffset =
    Number.isFinite(iqr) && Number.isFinite(difference)
      ? difference / iqr
      : (observed / 2 - median / 2) / (q3 / 2 - q1 / 2);
  requireFinite(normalizedOffset);
  return { band, normalizedOffset } as const;
}

export function evaluateThresholdRange(
  observed: number,
  { lower, upper }: { lower: number; upper: number },
) {
  requireFinite(observed, lower, upper);
  if (lower > upper) {
    throw new RangeError("Expected lower <= upper");
  }
  const signedDistance = observed - Math.min(upper, Math.max(lower, observed));
  requireFinite(signedDistance);
  return {
    band: observed < lower ? "below_range" : observed > upper ? "above_range" : "within_range",
    signedDistance,
  } as const;
}

interface ReferenceBandPoint {
  percent_0_to_100: number;
  mean: number;
  sd: number;
}

export interface WaveformReferenceBand
  extends Pick<NormalizedWaveform, "metric_id" | "interval_id" | "unit"> {
  points: readonly ReferenceBandPoint[];
}

function requireTimeGrid(times: readonly number[], end: number) {
  let previous = -1;
  if (times[0] !== 0 || times.at(-1) !== end) {
    throw new RangeError("Waveform grids must cover the full normalized interval");
  }
  for (const time of times) {
    if (!Number.isFinite(time) || time <= previous || time > end) {
      throw new RangeError("Waveform times must be strictly increasing");
    }
    previous = time;
  }
}

export function buildWaveformBandComparison(
  observedWaveform: NormalizedWaveform,
  referenceBand: WaveformReferenceBand,
) {
  const { metric_id, interval_id, unit } = observedWaveform;
  if (
    metric_id !== referenceBand.metric_id ||
    interval_id !== referenceBand.interval_id ||
    unit !== referenceBand.unit
  ) {
    throw new RangeError("Waveform and reference metric, interval and unit must match");
  }
  requireTimeGrid(
    observedWaveform.points.map(({ normalized_time_fraction }) => normalized_time_fraction),
    1,
  );
  requireTimeGrid(
    referenceBand.points.map(({ percent_0_to_100 }) => percent_0_to_100),
    100,
  );
  for (const { mean, sd } of referenceBand.points) {
    requireFinite(mean, sd);
    if (sd < 0) {
      throw new RangeError("Waveform standard deviations must be nonnegative");
    }
  }

  const reference = referenceBand.points[Symbol.iterator]();
  let left = reference.next().value as ReferenceBandPoint;
  let right = reference.next().value as ReferenceBandPoint;
  let inside = 0;
  const points = observedWaveform.points.map(({ normalized_time_fraction, value }) => {
    requireFinite(value);
    const percent = normalized_time_fraction * 100;
    while (percent > right.percent_0_to_100) {
      left = right;
      right = reference.next().value as ReferenceBandPoint;
    }
    const fraction =
      (percent - left.percent_0_to_100) / (right.percent_0_to_100 - left.percent_0_to_100);
    const mean = (1 - fraction) * left.mean + fraction * right.mean;
    const sd = (1 - fraction) * left.sd + fraction * right.sd;
    const lower = mean - sd;
    const upper = mean + sd;
    requireFinite(lower, upper);
    const in_band = lower <= value && value <= upper;
    inside += Number(in_band);
    return {
      percent_0_to_100: percent,
      observed_value: value,
      lower_1sd: lower,
      upper_1sd: upper,
      in_band,
    };
  });
  return { metric_id, interval_id, unit, points, in_band: inside / points.length };
}
