import type {
  EvidenceCatalog,
  KinematicMetrics,
  ShareReportSnapshot,
} from "@sports-motion/contracts";
import { type EvidenceFilters, findEligibleNormativeMetrics } from "./catalog.js";
import { evaluateMeanSd, evaluateMedianIqr, evaluateThresholdRange } from "./statistics.js";

type EvidenceComparison = ShareReportSnapshot["evidence_comparisons"][number];
type Study = EvidenceCatalog["studies"][number];
type VerifiedMetric = ReturnType<typeof findEligibleNormativeMetrics>[number]["metric"];

function evaluate(metric: VerifiedMetric, observed: number) {
  const { stat_type, values: reference_values } = metric;
  switch (stat_type) {
    case "mean_sd": {
      const { zScore, percentile, band } = evaluateMeanSd(observed, reference_values);
      return {
        stat_type,
        reference_values,
        detail: {
          band,
          z_score: zScore,
          percentile,
          percentile_method: "normal_distribution_estimate",
        },
      } as const;
    }
    case "median_iqr": {
      const { band, normalizedOffset } = evaluateMedianIqr(observed, reference_values);
      return {
        stat_type,
        reference_values,
        detail: { band, iqr_normalized_offset: normalizedOffset },
      };
    }
    case "threshold_range": {
      const { band, signedDistance } = evaluateThresholdRange(observed, reference_values);
      return { stat_type, reference_values, detail: { band, signed_distance: signedDistance } };
    }
  }
}

type StatisticDetail = ReturnType<typeof evaluate>["detail"];
type ResearcherDetail = EvidenceComparison &
  StatisticDetail & {
    study_id: Study["id"];
    population: Study["population_notes"];
    measurement_method: Study["measurement_modality"];
    comparability_bias_note: Study["comparability_bias_note"];
  };

export interface CoachingCheckpoint {
  coach_summary_ja: string;
  researcher_detail: ResearcherDetail;
  non_diagnostic_flag: true;
  disclaimer_text_ja: string;
}

const coachSummaries = {
  below_typical:
    "研究参加者に多く見られた範囲より小さめです。動画でこの場面の動きを確認しましょう。",
  within_typical:
    "研究参加者に多く見られた範囲に入っています。動画でこの場面の動きを確認しましょう。",
  above_typical:
    "研究参加者に多く見られた範囲より大きめです。動画でこの場面の動きを確認しましょう。",
  below_q1: "研究参加者の真ん中の半数が示した範囲より小さめです。",
  within_iqr: "研究参加者の真ん中の半数が示した範囲に入っています。",
  above_q3: "研究参加者の真ん中の半数が示した範囲より大きめです。",
  below_range: "研究で示された目安より小さめです。動画でこの場面の動きを確認しましょう。",
  within_range: "研究で示された目安の範囲に入っています。",
  above_range: "研究で示された目安より大きめです。動画でこの場面の動きを確認しましょう。",
} satisfies Record<StatisticDetail["band"], string>;

export function compareMetricsAgainstCatalog(
  kinematicMetrics: KinematicMetrics,
  catalog: EvidenceCatalog,
  options?: EvidenceFilters,
) {
  const evidence_comparisons: EvidenceComparison[] = [];
  const checkpoints: CoachingCheckpoint[] = [];

  for (const observed of kinematicMetrics.scalar_metrics) {
    if (observed.value_or_null === null) {
      continue;
    }
    const matches = findEligibleNormativeMetrics(
      catalog,
      { ...observed, movement_type: kinematicMetrics.movement_type },
      options,
    );
    for (const { metric, study } of matches) {
      if (
        metric.normalized_time_fraction !== undefined ||
        (metric.stat_type === "mean_sd" && metric.values.sd === 0)
      ) {
        continue;
      }
      const { detail, ...reference } = structuredClone(evaluate(metric, observed.value_or_null));
      const comparison: EvidenceComparison = {
        ...reference,
        metric_id: metric.metric_id,
        event_id: metric.event_id,
        unit: metric.unit,
        anatomical_plane: metric.anatomical_plane,
        ...(observed.side !== undefined && { side: observed.side }),
        source_doi: metric.source_doi,
        source_locator: metric.source_locator,
        source_authors: [...study.authors],
        source_year: study.year,
        source_journal: study.journal,
        measurement_modality: study.measurement_modality,
        cohort_notes: metric.cohort_notes,
        sample_size: metric.sample_size,
        observed_value: observed.value_or_null,
      };
      evidence_comparisons.push(comparison);
      checkpoints.push({
        coach_summary_ja: coachSummaries[detail.band],
        researcher_detail: {
          ...comparison,
          ...detail,
          study_id: study.id,
          population: study.population_notes,
          measurement_method: study.measurement_modality,
          comparability_bias_note: study.comparability_bias_note,
        },
        non_diagnostic_flag: true,
        disclaimer_text_ja: catalog.disclaimer_policy.user_facing_text_ja,
      });
    }
  }
  return { evidence_comparisons, checkpoints };
}
