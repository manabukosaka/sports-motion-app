import {
  asNormalizedPercent,
  asSeconds,
  type EvidenceCatalog,
  type FrameIndex,
  type KinematicMetrics,
  type NormalizedPercent,
  type Seconds,
  validateContract,
} from "@sports-motion/contracts";
import { buildWaveformBandComparison, type WaveformReferenceBand } from "@sports-motion/evidence";

export type MovementType = KinematicMetrics["movement_type"];
export type MovementEvent = KinematicMetrics["events"][number];
export type DiscreteEventId = MovementEvent["event_id"];
export type MetricId = KinematicMetrics["normalized_waveforms"][number]["metric_id"];
export type IntervalId = KinematicMetrics["normalized_waveforms"][number]["interval_id"];
export type MetricUnit = KinematicMetrics["normalized_waveforms"][number]["unit"];
export type AnatomicalPlane = KinematicMetrics["normalized_waveforms"][number]["anatomical_plane"];
export type Side = NonNullable<MovementEvent["side"]>;

type NormalizedWaveform = KinematicMetrics["normalized_waveforms"][number];
type ScalarMetric = KinematicMetrics["scalar_metrics"][number];

export const DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA =
  "用途はコーチングと動作分析の支援に限ります。医療診断や個人の傷害リスク判定への使用はできません。";

const ALLOWED_MOVEMENT_EVENTS: Readonly<Record<MovementType, readonly DiscreteEventId[]>> = {
  baseball_pitching: [
    "pitch_leg_lift",
    "pitch_foot_contact",
    "pitch_mer",
    "pitch_ball_release",
    "pitch_mir",
  ],
  running: ["run_initial_contact", "run_mid_stance", "run_toe_off", "run_next_initial_contact"],
  cmj: [
    "cmj_initiation",
    "cmj_peak_flexion",
    "cmj_takeoff",
    "cmj_initial_landing_contact",
    "cmj_peak_landing_flexion",
  ],
  dvj: [
    "dvj_initial_landing_contact",
    "dvj_peak_landing_flexion",
    "dvj_takeoff",
    "dvj_rebound_landing_contact",
  ],
};

const INTERVAL_EVENTS: Record<IntervalId, readonly [DiscreteEventId, DiscreteEventId]> = {
  pitch_cycle: ["pitch_leg_lift", "pitch_mir"],
  run_stride: ["run_initial_contact", "run_next_initial_contact"],
  run_stance: ["run_initial_contact", "run_toe_off"],
  cmj_cycle: ["cmj_initiation", "cmj_peak_landing_flexion"],
  dvj_cycle: ["dvj_initial_landing_contact", "dvj_takeoff"],
};

export interface ValidatedMovementEvents {
  readonly movement: MovementType;
  readonly events: readonly MovementEvent[];
  readonly startEvent: MovementEvent;
  readonly endEvent: MovementEvent;
  readonly durationSec: Seconds;
}

export function validateMovementEvents(
  movement: MovementType,
  events: readonly MovementEvent[],
): ValidatedMovementEvents {
  if (!Object.hasOwn(ALLOWED_MOVEMENT_EVENTS, movement)) {
    throw new TypeError(`Unsupported movement type: ${String(movement)}`);
  }
  if (!Array.isArray(events)) {
    throw new TypeError("Movement events must be an array");
  }
  if (events.length < 2) {
    throw new RangeError("At least two events are required to define a non-zero interval");
  }
  const allowed = ALLOWED_MOVEMENT_EVENTS[movement];
  const seenKeys = new Set<string>();
  const validated: MovementEvent[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!validateContract("capture_event", event)) {
      throw new TypeError(`Invalid movement event at index ${index}`);
    }
    if (!allowed.includes(event.event_id)) {
      throw new RangeError(`Event "${event.event_id}" is not allowed for movement "${movement}"`);
    }
    const key = `${event.event_id}:${event.side ?? ""}`;
    if (seenKeys.has(key)) {
      throw new RangeError(`Duplicate movement event "${event.event_id}"`);
    }
    seenKeys.add(key);

    if (!Number.isSafeInteger(event.frame_index)) {
      throw new RangeError(`Event "${event.event_id}" frame index exceeds safe integer precision`);
    }
    const previous = validated[index - 1];
    if (previous !== undefined) {
      if (event.frame_index <= previous.frame_index) {
        throw new RangeError("Movement event frame indices must be strictly increasing");
      }
      if (event.timestamp_sec <= previous.timestamp_sec) {
        throw new RangeError(
          "Movement event timestamps must be strictly increasing with non-zero duration",
        );
      }
    }
    validated.push(Object.freeze({ ...event }));
  }

  const startEvent = validated[0];
  const endEvent = validated.at(-1);
  if (!startEvent || !endEvent || endEvent.timestamp_sec <= startEvent.timestamp_sec) {
    throw new RangeError("Movement event interval must have strictly positive duration");
  }

  return Object.freeze({
    movement,
    events: Object.freeze(validated),
    startEvent,
    endEvent,
    durationSec: asSeconds(endEvent.timestamp_sec - startEvent.timestamp_sec),
  });
}

export interface ComparisonSeriesPoint {
  readonly percent: NormalizedPercent;
  readonly baselineValue: number;
  readonly targetValue: number;
  readonly delta: number;
  readonly referenceLower1Sd?: number;
  readonly referenceUpper1Sd?: number;
}

export interface PeakSummary {
  readonly percent: NormalizedPercent;
  readonly value: number;
}

export interface ScalarMetricDelta {
  readonly metricId: ScalarMetric["metric_id"];
  readonly eventId: ScalarMetric["event_id"];
  readonly unit: ScalarMetric["unit"];
  readonly anatomicalPlane: ScalarMetric["anatomical_plane"];
  readonly side?: Side;
  readonly baselineValue: number;
  readonly targetValue: number;
  readonly delta: number;
}

type Study = EvidenceCatalog["studies"][number];

export type ReferenceBandSource =
  | { readonly kind: "synthetic"; readonly dataset: string }
  | (Readonly<
      Pick<Study, "doi" | "year" | "journal" | "measurement_modality" | "population_notes">
    > & {
      readonly kind: "literature";
      readonly authors: readonly string[];
      readonly sample_size: number;
    });

export interface CoachingReferenceBand extends WaveformReferenceBand {
  readonly source: ReferenceBandSource;
}

export interface ReferenceBandSummary {
  readonly baselineInBandRatio: number;
  readonly targetInBandRatio: number;
  readonly source: ReferenceBandSource;
}

export interface ComparisonEventRange {
  readonly startFrame: FrameIndex;
  readonly endFrame: FrameIndex;
  readonly durationSec: Seconds;
}

export interface CompareTwoTrialsInput {
  readonly baseline: KinematicMetrics;
  readonly target: KinematicMetrics;
  readonly metricId: MetricId;
  readonly intervalId: IntervalId;
  readonly side?: Side;
  readonly referenceBand?: CoachingReferenceBand;
  readonly disclaimerTextJa?: string;
}

export interface TwoTrialComparison {
  readonly movementType: MovementType;
  readonly baselineRevisionId: string;
  readonly targetRevisionId: string;
  readonly baselineEventRange: ComparisonEventRange;
  readonly targetEventRange: ComparisonEventRange;
  readonly metricId: MetricId;
  readonly intervalId: IntervalId;
  readonly unit: MetricUnit;
  readonly anatomicalPlane: AnatomicalPlane;
  readonly side?: Side;
  readonly series: readonly ComparisonSeriesPoint[];
  readonly peakBaseline: PeakSummary;
  readonly peakTarget: PeakSummary;
  readonly peakDelta: number;
  readonly peakPhaseShiftPercent: number;
  readonly rmsDifference: number;
  readonly scalarDeltas: readonly ScalarMetricDelta[];
  readonly referenceBandSummary?: ReferenceBandSummary;
  readonly non_diagnostic_flag: true;
  readonly disclaimer_text_ja: string;
}

function comparisonEventRange(
  trial: KinematicMetrics,
  waveform: NormalizedWaveform,
): ComparisonEventRange {
  const bySide = new Map<MovementEvent["side"], MovementEvent[]>();
  for (const event of trial.events) {
    if (!ALLOWED_MOVEMENT_EVENTS[trial.movement_type].includes(event.event_id)) {
      throw new RangeError(`Event "${event.event_id}" is not allowed for "${trial.movement_type}"`);
    }
    const events = bySide.get(event.side);
    if (events) {
      events.push(event);
    } else {
      bySide.set(event.side, [event]);
    }
  }
  for (const events of bySide.values()) {
    if (events.length > 1) {
      validateMovementEvents(trial.movement_type, events);
    }
  }

  const { interval_id, side } = waveform;
  const fallbackSide =
    interval_id === "cmj_cycle" || interval_id === "dvj_cycle"
      ? bySide.get(side === "right" ? "left" : "right")
      : undefined;
  const findEvent = (id: DiscreteEventId) =>
    bySide.get(side)?.find((event) => event.event_id === id) ??
    bySide.get(undefined)?.find((event) => event.event_id === id) ??
    fallbackSide?.find((event) => event.event_id === id);
  const [startId, endId] = INTERVAL_EVENTS[interval_id];
  const start = findEvent(startId);
  const end = findEvent(endId);
  if (!start || !end) {
    throw new RangeError(
      `Trial "${trial.analysis_revision_id}" is missing events for "${interval_id}" interval`,
    );
  }
  const { durationSec } = validateMovementEvents(trial.movement_type, [start, end]);
  return Object.freeze({ startFrame: start.frame_index, endFrame: end.frame_index, durationSec });
}

function validateWaveformPoints(waveform: NormalizedWaveform): void {
  const { points } = waveform;
  if (points.length < 2) {
    throw new RangeError("Normalized waveform must contain at least two points");
  }
  let previous = -1;
  for (const point of points) {
    if (!Number.isFinite(point.normalized_time_fraction) || !Number.isFinite(point.value)) {
      throw new RangeError("Normalized waveform contains non-finite values");
    }
    if (point.normalized_time_fraction <= previous || point.normalized_time_fraction > 1) {
      throw new RangeError("Normalized waveform times must be strictly increasing within [0, 1]");
    }
    previous = point.normalized_time_fraction;
  }
  const first = points[0];
  const last = points.at(-1);
  if (first?.normalized_time_fraction !== 0 || last?.normalized_time_fraction !== 1) {
    throw new RangeError("Normalized waveform must cover the full [0, 1] interval");
  }
}

function findWaveform(
  metrics: KinematicMetrics,
  metricId: MetricId,
  intervalId: IntervalId,
  side?: Side,
): NormalizedWaveform {
  const candidates = metrics.normalized_waveforms.filter(
    (waveform) =>
      waveform.metric_id === metricId &&
      waveform.interval_id === intervalId &&
      (side === undefined || waveform.side === side),
  );
  const waveform = candidates[0];
  if (!waveform) {
    throw new RangeError(
      `Waveform "${metricId}" on interval "${intervalId}" was not found in analysis "${metrics.analysis_revision_id}"`,
    );
  }
  if (candidates.length > 1) {
    throw new RangeError(
      `Multiple waveforms match "${metricId}" on interval "${intervalId}"${side === undefined ? "; specify side" : ` for side "${side}"`}`,
    );
  }
  return waveform;
}

function interpolateWaveform(waveform: NormalizedWaveform, fraction: number): number {
  const { points } = waveform;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const point = points[mid];
    if (!point) {
      break;
    }
    if (point.normalized_time_fraction === fraction) {
      return point.value;
    }
    if (point.normalized_time_fraction < fraction) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const left = points[Math.max(0, high)];
  const right = points[Math.min(points.length - 1, low)];
  if (!left || !right) {
    throw new RangeError("Unable to interpolate waveform fraction");
  }
  if (left.normalized_time_fraction === right.normalized_time_fraction) {
    return left.value;
  }
  const alpha =
    (fraction - left.normalized_time_fraction) /
    (right.normalized_time_fraction - left.normalized_time_fraction);
  const interpolated = (1 - alpha) * left.value + alpha * right.value;
  if (!Number.isFinite(interpolated)) {
    throw new RangeError("Interpolated waveform value is not finite");
  }
  return interpolated;
}

function toNormalizedWaveform(
  template: NormalizedWaveform,
  fractions: readonly number[],
  values: readonly number[],
): NormalizedWaveform {
  const firstFraction = fractions[0];
  const secondFraction = fractions[1];
  const firstValue = values[0];
  const secondValue = values[1];
  if (
    firstFraction === undefined ||
    secondFraction === undefined ||
    firstValue === undefined ||
    secondValue === undefined
  ) {
    throw new RangeError("Unified waveform grid requires at least two points");
  }
  const rest = fractions.slice(2).map((normalized_time_fraction, index) => ({
    normalized_time_fraction,
    value: values[index + 2] as number,
  }));
  return {
    ...template,
    points: [
      { normalized_time_fraction: firstFraction, value: firstValue },
      { normalized_time_fraction: secondFraction, value: secondValue },
      ...rest,
    ],
  };
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function validateReferenceBandSource(source: ReferenceBandSource): ReferenceBandSource {
  const nonBlank = (value: unknown) => typeof value === "string" && /\S/u.test(value);
  if (source?.kind === "synthetic" && nonBlank(source.dataset)) {
    return Object.freeze({ kind: source.kind, dataset: source.dataset });
  }
  if (
    source?.kind === "literature" &&
    Array.isArray(source.authors) &&
    source.authors.length > 0 &&
    Array.from(source.authors).every(nonBlank) &&
    [source.doi, source.journal, source.measurement_modality, source.population_notes].every(
      nonBlank,
    ) &&
    Number.isSafeInteger(source.year) &&
    source.year > 0 &&
    Number.isSafeInteger(source.sample_size) &&
    source.sample_size > 0
  ) {
    return Object.freeze({ ...source, authors: Object.freeze([...source.authors]) });
  }
  throw new TypeError("Reference band requires source metadata");
}

function scalarMetricsByKey(metrics: readonly ScalarMetric[]) {
  const byKey = new Map<string, ScalarMetric>();
  for (const metric of metrics) {
    const key = `${metric.metric_id}:${metric.event_id}:${metric.side ?? ""}`;
    if (byKey.has(key)) {
      throw new RangeError(`Duplicate scalar metric "${key}"`);
    }
    byKey.set(key, metric);
  }
  return byKey;
}

function computeScalarDeltas(
  baseline: KinematicMetrics,
  target: KinematicMetrics,
): readonly ScalarMetricDelta[] {
  const targetByKey = scalarMetricsByKey(target.scalar_metrics);
  const deltas: ScalarMetricDelta[] = [];
  for (const [key, baseMetric] of scalarMetricsByKey(baseline.scalar_metrics)) {
    const targetMetric = targetByKey.get(key);
    if (!targetMetric) {
      continue;
    }
    if (baseMetric.unit !== targetMetric.unit) {
      throw new RangeError(
        `Scalar metric "${baseMetric.metric_id}" unit mismatch (${baseMetric.unit} vs ${targetMetric.unit})`,
      );
    }
    if (baseMetric.anatomical_plane !== targetMetric.anatomical_plane) {
      throw new RangeError(
        `Scalar metric "${baseMetric.metric_id}" anatomical plane mismatch (${baseMetric.anatomical_plane} vs ${targetMetric.anatomical_plane})`,
      );
    }
    if (baseMetric.value_or_null === null || targetMetric.value_or_null === null) {
      continue;
    }
    if (
      !Number.isFinite(baseMetric.value_or_null) ||
      !Number.isFinite(targetMetric.value_or_null)
    ) {
      throw new RangeError(`Scalar metric "${baseMetric.metric_id}" contains non-finite values`);
    }
    const delta = normalizeZero(targetMetric.value_or_null - baseMetric.value_or_null);
    if (!Number.isFinite(delta)) {
      throw new RangeError(`Scalar metric "${baseMetric.metric_id}" delta is not finite`);
    }
    deltas.push(
      Object.freeze({
        metricId: baseMetric.metric_id,
        eventId: baseMetric.event_id,
        unit: baseMetric.unit,
        anatomicalPlane: baseMetric.anatomical_plane,
        ...(baseMetric.side !== undefined ? { side: baseMetric.side } : {}),
        baselineValue: baseMetric.value_or_null,
        targetValue: targetMetric.value_or_null,
        delta,
      }),
    );
  }
  return Object.freeze(deltas);
}

export function compareTwoTrials(input: CompareTwoTrialsInput): TwoTrialComparison {
  if (!validateContract("kinematic_metrics", input.baseline)) {
    throw new TypeError("Invalid baseline kinematic_metrics contract");
  }
  if (!validateContract("kinematic_metrics", input.target)) {
    throw new TypeError("Invalid target kinematic_metrics contract");
  }
  if (input.baseline.movement_type !== input.target.movement_type) {
    throw new RangeError(
      `Cannot compare different movement types (${input.baseline.movement_type} vs ${input.target.movement_type})`,
    );
  }
  const disclaimerText = input.disclaimerTextJa ?? DEFAULT_NON_DIAGNOSTIC_DISCLAIMER_JA;
  if (typeof disclaimerText !== "string" || !/\S/u.test(disclaimerText)) {
    throw new TypeError("Non-diagnostic disclaimer text must be non-blank");
  }

  const baselineWave = findWaveform(input.baseline, input.metricId, input.intervalId, input.side);
  const targetWave = findWaveform(input.target, input.metricId, input.intervalId, input.side);

  if (baselineWave.unit !== targetWave.unit) {
    throw new RangeError(
      `Cannot compare waveforms with mismatched units (${baselineWave.unit} vs ${targetWave.unit})`,
    );
  }
  if (baselineWave.anatomical_plane !== targetWave.anatomical_plane) {
    throw new RangeError(
      `Cannot compare waveforms from different anatomical planes (${baselineWave.anatomical_plane} vs ${targetWave.anatomical_plane})`,
    );
  }
  if (baselineWave.side !== targetWave.side) {
    throw new RangeError(
      `Cannot compare waveforms from different sides (${String(baselineWave.side)} vs ${String(targetWave.side)})`,
    );
  }

  validateWaveformPoints(baselineWave);
  validateWaveformPoints(targetWave);
  const baselineEventRange = comparisonEventRange(input.baseline, baselineWave);
  const targetEventRange = comparisonEventRange(input.target, targetWave);
  const bandSource = input.referenceBand && validateReferenceBandSource(input.referenceBand.source);

  const trialGrid = new Map<number, number>();
  for (const waveform of [baselineWave, targetWave]) {
    for (const { normalized_time_fraction: fraction } of waveform.points) {
      const percent = fraction * 100;
      trialGrid.set(percent, Math.min(fraction, trialGrid.get(percent) ?? fraction));
    }
  }
  const grid = new Map(trialGrid);
  for (const { percent_0_to_100 } of input.referenceBand?.points ?? []) {
    if (!Number.isFinite(percent_0_to_100) || percent_0_to_100 < 0 || percent_0_to_100 > 100) {
      throw new RangeError("Reference band percent must be within [0, 100]");
    }
    const fraction = percent_0_to_100 / 100;
    const percent = fraction * 100;
    if (!grid.has(percent)) {
      grid.set(percent, fraction);
    }
  }
  const unifiedFractions = Array.from(grid.values()).sort((first, second) => first - second);
  const baselineValues = unifiedFractions.map((fraction) =>
    interpolateWaveform(baselineWave, fraction),
  );
  const targetValues = unifiedFractions.map((fraction) =>
    interpolateWaveform(targetWave, fraction),
  );

  let baselineBand: ReturnType<typeof buildWaveformBandComparison> | undefined;
  let targetBand: ReturnType<typeof buildWaveformBandComparison> | undefined;
  if (input.referenceBand !== undefined) {
    const resampledBaseline = toNormalizedWaveform(baselineWave, unifiedFractions, baselineValues);
    const resampledTarget = toNormalizedWaveform(targetWave, unifiedFractions, targetValues);
    baselineBand = buildWaveformBandComparison(resampledBaseline, input.referenceBand);
    targetBand = buildWaveformBandComparison(resampledTarget, input.referenceBand);
  }

  let peakBaseline: PeakSummary | undefined;
  let peakTarget: PeakSummary | undefined;
  let squaredDeltaSum = 0;
  let baselineInBand = 0;
  let targetInBand = 0;

  const series: ComparisonSeriesPoint[] = unifiedFractions.map((fraction, index) => {
    const percent = asNormalizedPercent(fraction * 100);
    const baselineValue = baselineValues[index] as number;
    const targetValue = targetValues[index] as number;
    const delta = normalizeZero(targetValue - baselineValue);
    if (!Number.isFinite(delta)) {
      throw new RangeError("Waveform comparison delta is not finite");
    }
    if (trialGrid.has(percent)) {
      squaredDeltaSum += delta * delta;
      baselineInBand += Number(baselineBand?.points[index]?.in_band === true);
      targetInBand += Number(targetBand?.points[index]?.in_band === true);
      if (peakBaseline === undefined || baselineValue > peakBaseline.value) {
        peakBaseline = Object.freeze({ percent, value: baselineValue });
      }
      if (peakTarget === undefined || targetValue > peakTarget.value) {
        peakTarget = Object.freeze({ percent, value: targetValue });
      }
    }

    const bandPoint = targetBand?.points[index];
    return Object.freeze({
      percent,
      baselineValue,
      targetValue,
      delta,
      ...(bandPoint !== undefined
        ? { referenceLower1Sd: bandPoint.lower_1sd, referenceUpper1Sd: bandPoint.upper_1sd }
        : {}),
    });
  });

  if (!peakBaseline || !peakTarget) {
    throw new RangeError("Comparison series cannot be empty");
  }

  const rmsDifference = Math.sqrt(squaredDeltaSum / trialGrid.size);
  const peakDelta = normalizeZero(peakTarget.value - peakBaseline.value);
  const peakPhaseShiftPercent = normalizeZero(peakTarget.percent - peakBaseline.percent);
  if (
    !Number.isFinite(rmsDifference) ||
    !Number.isFinite(peakDelta) ||
    !Number.isFinite(peakPhaseShiftPercent)
  ) {
    throw new RangeError("Comparison summary statistics must be finite");
  }

  const scalarDeltas = computeScalarDeltas(input.baseline, input.target);
  const resolvedSide = baselineWave.side;

  return Object.freeze({
    movementType: input.baseline.movement_type,
    baselineRevisionId: input.baseline.analysis_revision_id,
    targetRevisionId: input.target.analysis_revision_id,
    baselineEventRange,
    targetEventRange,
    metricId: input.metricId,
    intervalId: input.intervalId,
    unit: baselineWave.unit,
    anatomicalPlane: baselineWave.anatomical_plane,
    ...(resolvedSide !== undefined ? { side: resolvedSide } : {}),
    series: Object.freeze(series),
    peakBaseline,
    peakTarget,
    peakDelta,
    peakPhaseShiftPercent,
    rmsDifference,
    scalarDeltas,
    ...(bandSource !== undefined
      ? {
          referenceBandSummary: Object.freeze({
            baselineInBandRatio: baselineInBand / trialGrid.size,
            targetInBandRatio: targetInBand / trialGrid.size,
            source: bandSource,
          }),
        }
      : {}),
    non_diagnostic_flag: true,
    disclaimer_text_ja: disclaimerText,
  });
}
