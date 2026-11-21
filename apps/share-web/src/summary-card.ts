import { type ShareReportSnapshot, validateContract } from "@sports-motion/contracts";

const movementLabels = {
  baseball_pitching: "野球投球",
  running: "ランニング",
  cmj: "垂直跳び（CMJ）",
  dvj: "ドロップ垂直跳び（DVJ）",
} satisfies Record<ShareReportSnapshot["kinematic_summary"]["movement_type"], string>;

function escapeXml(value: string) {
  return value
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "\uFFFD")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function text(value: string, x: number, y: number, size: number, width: number, style: string) {
  const estimatedWidth = Array.from(value).reduce(
    (sum, character) => sum + (character <= "\u007f" ? 0.65 : 1) * size,
    0,
  );
  const fit =
    estimatedWidth > width ? ` textLength="${width}" lengthAdjust="spacingAndGlyphs"` : "";
  return `<text x="${x}" y="${y}" font-size="${size}" class="${style}"${fit}>${escapeXml(value)}</text>`;
}

function referenceLabel(comparison: ShareReportSnapshot["evidence_comparisons"][number]) {
  switch (comparison.stat_type) {
    case "mean_sd":
      return `平均 ${comparison.reference_values.mean} ± ${comparison.reference_values.sd}`;
    case "median_iqr":
      return `中央値 ${comparison.reference_values.median}（IQR ${comparison.reference_values.q1}–${comparison.reference_values.q3}）`;
    case "threshold_range":
      return `参照範囲 ${comparison.reference_values.lower}–${comparison.reference_values.upper}`;
  }
}

export function renderShareSummaryCardSvg(snapshot: unknown): string {
  if (!validateContract("share_report", snapshot) || snapshot.non_diagnostic_flag !== true) {
    throw new TypeError("Invalid non-diagnostic share report");
  }

  const { kinematic_summary, evidence_comparisons, disclaimer_text_ja } = snapshot;
  const metrics = kinematic_summary.scalar_metrics
    .filter(({ value_or_null }) => value_or_null !== null)
    .slice(0, 3)
    .map(({ metric_id, event_id, side, value_or_null, unit }, index) => {
      const x = 48 + 376 * index;
      const context = [event_id, side].filter(Boolean).join(" · ");
      return `<g><rect x="${x}" y="248" width="352" height="119" rx="16" fill="#fff"/>
${text(metric_id, x + 20, 278, 17, 312, "label")}
${text(context, x + 20, 304, 15, 312, "muted")}
${text(`${value_or_null} ${unit}`, x + 20, 346, 34, 312, "label")}</g>`;
    })
    .join("\n");
  const comparisons = evidence_comparisons
    .slice(0, 3)
    .map((comparison, index) => {
      const x = 48 + 376 * index;
      const summary = `観測 ${comparison.observed_value} · ${referenceLabel(comparison)} ${comparison.unit}（n=${comparison.sample_size}）`;
      return `<g><title>${escapeXml(`${comparison.source_doi} · ${comparison.source_locator}`)}</title>
<rect x="${x}" y="426" width="352" height="74" rx="14" fill="#d4eee8"/>
${text(comparison.metric_id, x + 18, 453, 16, 316, "label")}
${text(summary, x + 18, 481, 16, 316, "label")}</g>`;
    })
    .join("\n");

  const disclaimer = Array.from(disclaimer_text_ja);
  const firstLine = disclaimer.slice(0, 64).join("");
  const secondLine = disclaimer.slice(64).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="card-title card-disclaimer" xml:lang="ja">
<title id="card-title">動作分析レポート</title>
<desc id="card-disclaimer">${escapeXml(disclaimer_text_ja)}</desc>
<style>text{font-family:system-ui,sans-serif;fill:#123b3c}.light{fill:#fff}.mint{fill:#bdebe0}.label{font-weight:700}.muted{fill:#3d595a}</style>
<rect width="1200" height="630" fill="#edf6f3"/>
<path d="M0 0H1200V192H0Z" fill="#123b3c"/>
${text("動作分析レポート", 48, 85, 52, 1090, "light label")}
${text(movementLabels[kinematic_summary.movement_type], 50, 123, 24, 1090, "mint label")}
<rect x="48" y="140" width="542" height="34" rx="17" fill="#255354"/>
<rect x="610" y="140" width="542" height="34" rx="17" fill="#255354"/>
${text(`解析リビジョン  ${snapshot.analysis_revision_id}`, 64, 163, 16, 510, "light")}
${text(`エビデンス版  ${snapshot.evidence_registry_version}`, 626, 163, 16, 510, "light")}
${text("主要指標", 48, 231, 25, 1104, "label")}
${metrics || text("表示できる計測結果がありません", 48, 291, 21, 1104, "muted")}
${text("文献との比較", 48, 408, 25, 1104, "label")}
${comparisons || text("参照文献データ未登録", 48, 465, 21, 1104, "muted")}
<rect x="48" y="527" width="1104" height="73" rx="14" fill="#123b3c"/>
${text(firstLine, 68, secondLine ? 557 : 570, 18, 1064, "light label")}
${secondLine ? text(secondLine, 68, 582, 18, 1064, "light label") : ""}
</svg>`;
}
