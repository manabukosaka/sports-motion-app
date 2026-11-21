import { type KinematicMetrics, validateContract } from "@sports-motion/contracts";

type ScalarMetric = KinematicMetrics["scalar_metrics"][number];

export interface LongitudinalTrial {
  teamId: string;
  athleteId: string;
  sessionId: string;
  trialId: string;
  capturedAt: string;
  metrics: KinematicMetrics;
}

export interface LongitudinalQuery {
  teamId: string;
  athleteId: string;
  metricId: ScalarMetric["metric_id"];
  eventId: ScalarMetric["event_id"];
  trials: readonly LongitudinalTrial[];
}

export function buildLongitudinalSeries({
  teamId,
  athleteId,
  metricId,
  eventId,
  trials,
}: LongitudinalQuery) {
  for (const trial of trials) {
    if (trial.teamId !== teamId || trial.athleteId !== athleteId) {
      throw new Error("Trial is outside the requested team and athlete scope");
    }
  }

  const ordered = trials
    .map((trial) => {
      const time = Date.parse(trial.capturedAt);
      if (!Number.isFinite(time) || !validateContract("kinematic_metrics", trial.metrics)) {
        throw new TypeError("Invalid longitudinal trial timestamp or metrics");
      }
      return { trial, time };
    })
    .sort((first, second) => first.time - second.time);

  let unit: ScalarMetric["unit"] | null = null;
  let best = -Infinity;
  let scale = 0;
  const points = ordered.flatMap(({ trial }) =>
    trial.metrics.scalar_metrics.flatMap((metric) => {
      if (
        metric.metric_id !== metricId ||
        metric.event_id !== eventId ||
        metric.value_or_null === null
      ) {
        return [];
      }
      if (unit !== null && unit !== metric.unit) {
        throw new Error("Longitudinal metric units must match");
      }
      unit = metric.unit;
      const value = metric.value_or_null;
      best = Math.max(best, value);
      scale = Math.max(scale, Math.abs(value));
      return [
        {
          sessionId: trial.sessionId,
          trialId: trial.trialId,
          capturedAt: trial.capturedAt,
          analysisRevisionId: trial.metrics.analysis_revision_id,
          side: metric.side,
          value,
          unit: metric.unit,
        },
      ];
    }),
  );

  const count = points.length;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    return {
      teamId,
      athleteId,
      metricId,
      eventId,
      unit,
      points,
      summary: { count, latest: null, best: null, deltaFromFirst: null, mean: null, sd: null },
    };
  }

  const deltaFromFirst = last.value - first.value;
  if (!Number.isFinite(deltaFromFirst)) {
    throw new RangeError("Longitudinal delta exceeds the finite numeric range");
  }
  const divisor = scale || 1;
  const normalizedMean = points.reduce((sum, { value }) => sum + value / divisor, 0) / count;
  const variance =
    points.reduce((sum, { value }) => sum + (value / divisor - normalizedMean) ** 2, 0) / count;
  return {
    teamId,
    athleteId,
    metricId,
    eventId,
    unit,
    points,
    summary: {
      count,
      latest: last.value,
      best,
      deltaFromFirst,
      mean: normalizedMean * scale,
      sd: Math.sqrt(variance) * scale,
    },
  };
}
