import {
  type EvidenceCatalog,
  type KinematicMetrics,
  validateContract,
} from "@sports-motion/contracts";
import initialCatalog from "../../../docs/evidence/initial-literature-catalog.json" with {
  type: "json",
};

type Study = EvidenceCatalog["studies"][number];
type NormativeMetric = EvidenceCatalog["normative_metrics"][number];
type VerifiedMetric = Extract<NormativeMetric, { status: "verified_normative" }>;
type ScalarMetric = KinematicMetrics["scalar_metrics"][number];

export interface EvidenceFilters {
  population?: Study["population_notes"];
  measurement_method?: Study["measurement_modality"];
}

type MetricKey = Pick<ScalarMetric, "metric_id" | "event_id" | "unit" | "anatomical_plane"> & {
  movement_type: KinematicMetrics["movement_type"];
};

export function loadEvidenceCatalog(snapshot: unknown = initialCatalog): EvidenceCatalog {
  if (!validateContract("evidence_catalog", snapshot)) {
    throw new TypeError("Invalid evidence catalog");
  }
  const ids = new Set(snapshot.studies.map(({ id }) => id));
  const studies = new Map(snapshot.studies.map((study) => [study.doi.toLowerCase(), study]));
  if (ids.size !== snapshot.studies.length || studies.size !== snapshot.studies.length) {
    throw new TypeError("Duplicate evidence study ID or DOI");
  }
  for (const metric of snapshot.normative_metrics) {
    if (!studies.get(metric.source_doi.toLowerCase())?.metrics_covered.includes(metric.metric_id)) {
      throw new TypeError("Normative metric has no matching source study");
    }
    if (metric.status === "verified_normative") {
      if (
        metric.stat_type === "median_iqr" &&
        (metric.values.q1 > metric.values.median || metric.values.median > metric.values.q3)
      ) {
        throw new RangeError("Invalid evidence quartile order");
      }
      if (metric.stat_type === "threshold_range" && metric.values.lower > metric.values.upper) {
        throw new RangeError("Inverted evidence threshold range");
      }
    }
  }
  return structuredClone(snapshot);
}

export function findEligibleNormativeMetrics(
  catalog: EvidenceCatalog,
  key: MetricKey,
  { population, measurement_method }: EvidenceFilters = {},
): { metric: VerifiedMetric; study: Study }[] {
  const { movement_type } = key;
  const jump = movement_type === "cmj" || movement_type === "dvj";
  if (jump && !key.event_id.startsWith(`${movement_type}_`)) {
    return [];
  }
  const domain = jump ? "jump_landing" : movement_type;
  const studies = new Map(
    catalog.studies
      .filter(
        (study) =>
          study.extraction_status === "verified_normative" &&
          study.domain === domain &&
          study.metrics_covered.includes(key.metric_id) &&
          (population === undefined || study.population_notes === population) &&
          (measurement_method === undefined || study.measurement_modality === measurement_method),
      )
      .map((study) => [study.doi.toLowerCase(), study]),
  );
  return catalog.normative_metrics.flatMap((metric) => {
    if (
      metric.status !== "verified_normative" ||
      metric.metric_id !== key.metric_id ||
      metric.event_id !== key.event_id ||
      metric.unit !== key.unit ||
      metric.anatomical_plane !== key.anatomical_plane
    ) {
      return [];
    }
    const study = studies.get(metric.source_doi.toLowerCase());
    return study ? [{ metric, study }] : [];
  });
}
