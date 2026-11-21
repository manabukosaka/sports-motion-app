import { type ShareReportSnapshot, validateContract } from "@sports-motion/contracts";

interface ShareReportViewModel {
  shareLinkId: ShareReportSnapshot["share_link_id"];
  analysisRevisionId: ShareReportSnapshot["analysis_revision_id"];
  nonDiagnostic: ShareReportSnapshot["non_diagnostic_flag"];
  disclaimerText: ShareReportSnapshot["disclaimer_text_ja"];
}

export function shareReportViewModel(value: unknown): ShareReportViewModel | undefined {
  if (!validateContract("share_report", value) || value.non_diagnostic_flag !== true) {
    return undefined;
  }
  return {
    shareLinkId: value.share_link_id,
    analysisRevisionId: value.analysis_revision_id,
    nonDiagnostic: value.non_diagnostic_flag,
    disclaimerText: value.disclaimer_text_ja,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function referenceValues(comparison: ShareReportSnapshot["evidence_comparisons"][number]) {
  switch (comparison.stat_type) {
    case "mean_sd":
      return `平均 ${comparison.reference_values.mean} ± ${comparison.reference_values.sd}`;
    case "median_iqr":
      return `中央値 ${comparison.reference_values.median}（四分位範囲 ${comparison.reference_values.q1}–${comparison.reference_values.q3}）`;
    case "threshold_range":
      return `参照範囲 ${comparison.reference_values.lower}–${comparison.reference_values.upper}`;
  }
}

export function renderShareReportHtml(snapshot: unknown): string {
  if (!validateContract("share_report", snapshot) || snapshot.non_diagnostic_flag !== true) {
    throw new TypeError("Invalid non-diagnostic share report");
  }
  const revision = escapeHtml(snapshot.analysis_revision_id);
  const registry = escapeHtml(snapshot.evidence_registry_version);
  const disclaimer = escapeHtml(snapshot.disclaimer_text_ja);
  const metrics = snapshot.kinematic_summary.scalar_metrics
    .map(
      (metric) =>
        `<li>${escapeHtml(metric.metric_id)} (${escapeHtml(metric.event_id)}): ${metric.value_or_null ?? escapeHtml(metric.missing_reason_or_null ?? "")} ${escapeHtml(metric.unit)}</li>`,
    )
    .join("");
  const comparisons = snapshot.evidence_comparisons
    .map(
      (comparison) =>
        `<li>${escapeHtml(comparison.metric_id)} (${escapeHtml(comparison.event_id)}): 観測値 ${comparison.observed_value} ${escapeHtml(comparison.unit)}。文献値 ${referenceValues(comparison)} ${escapeHtml(comparison.unit)} (${escapeHtml(comparison.source_doi)}, n=${comparison.sample_size})</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<meta property="og:type" content="website">
<meta property="og:title" content="動作分析レポート">
<meta property="og:description" content="${disclaimer}">
<title>動作分析レポート</title></head>
<body><main data-analysis-revision-id="${revision}" data-evidence-registry-version="${registry}" data-non-diagnostic="true">
<h1>動作分析レポート</h1><p id="disclaimer">${disclaimer}</p>
<dl><dt>解析リビジョン</dt><dd>${revision}</dd><dt>エビデンス版</dt><dd>${registry}</dd></dl>
${metrics ? `<section><h2>計測結果</h2><ul>${metrics}</ul></section>` : ""}
${comparisons ? `<section><h2>文献との比較</h2><ul>${comparisons}</ul></section>` : ""}
</main></body></html>`;
}
