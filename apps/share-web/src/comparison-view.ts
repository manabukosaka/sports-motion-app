import {
  type CoachingComment,
  type ComparisonEventRange,
  type DrawingAnnotation,
  PLAYBACK_RATES,
  type TwoTrialComparison,
  validateCoachingComment,
  validateDrawingAnnotation,
} from "@sports-motion/coaching";

export interface TwoTrialComparisonViewOptions {
  readonly comparison: TwoTrialComparison;
  readonly annotations?: readonly DrawingAnnotation[];
  readonly comments?: readonly CoachingComment[];
  readonly disclaimerTextJa?: string;
  readonly baselineLabel?: string;
  readonly targetLabel?: string;
  readonly baselineEventRange?: { readonly startFrame: number; readonly endFrame: number };
  readonly targetEventRange?: { readonly startFrame: number; readonly endFrame: number };
}

interface ComparisonViewerPayload {
  series: Array<{
    percent: number;
    baselineValue: number;
    targetValue: number;
  }>;
  baselineRange: { startFrame: number; endFrame: number };
  targetRange: { startFrame: number; endFrame: number };
  durationSec: number;
  unit: string;
}

const CHART_LEFT = 16;
const CHART_WIDTH = 312;
const CHART_TOP = 16;
const CHART_HEIGHT = 124;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const jsonEscapes: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => jsonEscapes[character] ?? character,
  );
}

function validateEventRange(
  range: { readonly startFrame: number; readonly endFrame: number } | undefined,
  fallback: ComparisonEventRange,
) {
  const { startFrame, endFrame } = range ?? fallback;
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame
  ) {
    throw new RangeError("Event frame range must satisfy 0 <= startFrame < endFrame");
  }
  return { startFrame, endFrame };
}

function renderAnnotationSvg(annotation: DrawingAnnotation): string {
  const width = 344;
  const height = 194;
  const id = escapeHtml(annotation.id);
  const color = escapeHtml(annotation.colorHex);
  const px = (value: number) => (value * width).toFixed(2);
  const py = (value: number) => (value * height).toFixed(2);
  const baseAttr = `data-annotation-id="${id}" data-start-frame="${annotation.startFrame}" data-end-frame="${annotation.endFrame}"`;

  switch (annotation.kind) {
    case "line": {
      const [first, second] = annotation.points;
      if (!first || !second) {
        return "";
      }
      return `<g ${baseAttr}><line x1="${px(first.x)}" y1="${py(first.y)}" x2="${px(second.x)}" y2="${py(second.y)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/></g>`;
    }
    case "angle": {
      const polylinePoints = annotation.points
        .map((point) => `${px(point.x)},${py(point.y)}`)
        .join(" ");
      return `<g ${baseAttr}><polyline points="${polylinePoints}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/></g>`;
    }
    case "circle": {
      const [center, edge] = annotation.points;
      if (!center) {
        return "";
      }
      const radiusPx = edge
        ? Math.hypot((edge.x - center.x) * width, (edge.y - center.y) * height)
        : (annotation.radius ?? 0.05) * Math.min(width, height);
      return `<g ${baseAttr}><circle cx="${px(center.x)}" cy="${py(center.y)}" r="${radiusPx.toFixed(2)}" fill="none" stroke="${color}" stroke-width="2.5"/></g>`;
    }
    case "label": {
      const [anchor] = annotation.points;
      if (!anchor) {
        return "";
      }
      return `<g ${baseAttr}><text x="${px(anchor.x)}" y="${py(anchor.y)}" fill="${color}" font-size="13" font-weight="600">${escapeHtml(annotation.label ?? "")}</text></g>`;
    }
  }
}

function runComparisonViewer(chartLeft: number, chartWidth: number) {
  const main = document.querySelector<HTMLElement>("main");
  const scrubber = document.querySelector<HTMLInputElement>("#compare-scrubber");
  const cursor = document.querySelector<SVGLineElement>("#comparison-cursor");
  const trialAIndicator = document.querySelector<HTMLOutputElement>("#trial-a-indicator");
  const trialBIndicator = document.querySelector<HTMLOutputElement>("#trial-b-indicator");
  const syncDeltaIndicator = document.querySelector<HTMLOutputElement>("#sync-delta-indicator");
  const controls = document.querySelector<HTMLElement>("#playback-controls");
  const playButton = document.querySelector<HTMLButtonElement>("#comparison-playback-toggle");
  const overlay = document.querySelector<SVGSVGElement>("#annotation-overlay");
  const source = document.querySelector("#comparison-data");
  if (
    !main ||
    !scrubber ||
    !cursor ||
    !trialAIndicator ||
    !trialBIndicator ||
    !syncDeltaIndicator ||
    !controls ||
    !playButton ||
    !overlay ||
    !source?.textContent
  ) {
    return;
  }
  const payload: ComparisonViewerPayload = JSON.parse(source.textContent);
  const rateButtons = Array.from(controls.querySelectorAll<HTMLButtonElement>("button.rate-btn"));
  const annotations = Array.from(
    overlay.querySelectorAll<SVGGElement>("[data-annotation-id]"),
    (group) => ({
      group,
      start: Number(group.getAttribute("data-start-frame")),
      end: Number(group.getAttribute("data-end-frame")),
    }),
  );
  let rate = 1;
  let animation: number | undefined;
  let previousTime = 0;

  const sampleAt = (percent: number) => {
    const index = payload.series.findIndex((point) => point.percent >= percent);
    const right = payload.series[index];
    const left = payload.series[index - 1];
    if (!left || !right || right.percent === percent) {
      return right;
    }
    const weight = (percent - left.percent) / (right.percent - left.percent);
    return {
      baselineValue: (1 - weight) * left.baselineValue + weight * right.baselineValue,
      targetValue: (1 - weight) * left.targetValue + weight * right.targetValue,
    };
  };

  const update = () => {
    const percent = Math.max(0, Math.min(100, scrubber.valueAsNumber || 0));
    const exactFrame = ({ startFrame, endFrame }: ComparisonViewerPayload["baselineRange"]) =>
      startFrame + (percent / 100) * (endFrame - startFrame);
    const exactA = exactFrame(payload.baselineRange);
    const exactB = exactFrame(payload.targetRange);
    const frameA = Math.round(exactA);
    const frameB = Math.round(exactB);
    const syncDelta = Math.max(Math.abs(frameA - exactA), Math.abs(frameB - exactB));
    const x = chartLeft + (chartWidth * percent) / 100;
    cursor.setAttribute("x1", String(x));
    cursor.setAttribute("x2", String(x));
    const sample = sampleAt(percent);
    trialAIndicator.setAttribute("data-percent", String(percent));
    trialAIndicator.setAttribute("data-frame", String(frameA));
    trialAIndicator.value = `${percent.toFixed(0)}% (F${frameA}${sample ? ` · ${sample.baselineValue.toFixed(1)} ${payload.unit}` : ""})`;
    trialBIndicator.setAttribute("data-percent", String(percent));
    trialBIndicator.setAttribute("data-frame", String(frameB));
    trialBIndicator.value = `${percent.toFixed(0)}% (F${frameB}${sample ? ` · ${sample.targetValue.toFixed(1)} ${payload.unit}` : ""})`;
    syncDeltaIndicator.setAttribute("data-sync-delta", String(syncDelta));
    syncDeltaIndicator.value = `Δ ${syncDelta.toFixed(2)} frame`;
    scrubber.setAttribute("aria-valuetext", `${percent.toFixed(1)}%`);

    for (const { group, start, end } of annotations) {
      group.setAttribute("visibility", frameA >= start && frameA <= end ? "visible" : "hidden");
    }
  };

  const pause = () => {
    if (animation !== undefined) {
      cancelAnimationFrame(animation);
      animation = undefined;
    }
    playButton.textContent = "再生";
  };
  const advance = (timestamp: number) => {
    const elapsedSec = (timestamp - previousTime) / 1000;
    previousTime = timestamp;
    const percent = Math.min(
      100,
      scrubber.valueAsNumber + (elapsedSec * rate * 100) / payload.durationSec,
    );
    scrubber.valueAsNumber = percent;
    update();
    if (percent === 100) {
      pause();
    } else {
      animation = requestAnimationFrame(advance);
    }
  };
  playButton.addEventListener("click", () => {
    if (animation !== undefined) {
      pause();
      return;
    }
    if (scrubber.valueAsNumber === 100) {
      scrubber.valueAsNumber = 0;
      update();
    }
    previousTime = performance.now();
    playButton.textContent = "一時停止";
    animation = requestAnimationFrame(advance);
  });

  for (const button of rateButtons) {
    button.addEventListener("click", () => {
      rate = Number(button.getAttribute("data-rate"));
      main.setAttribute("data-rate", String(rate));
      controls.setAttribute("data-rate", String(rate));
      for (const candidate of rateButtons) {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      }
    });
  }

  scrubber.addEventListener("input", update);
  update();
}

const comparisonStyles = `<style>
  :root { font-family: system-ui, sans-serif; color: #182936; background: #edf3f4; }
  body { margin: 0; }
  main { box-sizing: border-box; max-width: 42rem; margin: auto; padding: 18px 14px 32px; }
  h1 { margin: 0 0 8px; font-size: 1.35rem; }
  h2 { margin: 0 0 8px; font-size: 1.05rem; }
  p { margin: 0 0 10px; }
  #disclaimer { padding: 10px 12px; border-left: 3px solid #047c6d; background: #fff; font-size: 0.9rem; }
  .panel { background: #fff; border: 1px solid #cfdddf; border-radius: 14px; padding: 12px; margin-top: 12px; }
  svg { width: 100%; height: auto; border-radius: 8px; background: #f6fafb; display: block; }
  #annotation-overlay { background: #102632; }
  .indicators { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; font-size: 0.85rem; }
  .indicator { background: #edf3f4; border-radius: 8px; padding: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .rate-btn { border: 1px solid #047c6d; background: #fff; color: #047c6d; border-radius: 999px; padding: 6px 12px; font-weight: 600; }
  .rate-btn[aria-pressed="true"] { background: #047c6d; color: #fff; }
  input[type=range] { width: 100%; min-height: 36px; accent-color: #047c6d; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 6px; overflow-wrap: anywhere; }
</style>`;

export function renderTwoTrialComparisonHtml(options: TwoTrialComparisonViewOptions): string {
  if (options === null || typeof options !== "object" || !options.comparison) {
    throw new TypeError("Comparison view options require a TwoTrialComparison");
  }
  const { comparison } = options;
  if (comparison.non_diagnostic_flag !== true) {
    throw new TypeError("Comparison view requires non_diagnostic_flag === true");
  }
  const disclaimer = options.disclaimerTextJa ?? comparison.disclaimer_text_ja;
  if (typeof disclaimer !== "string" || !/\S/u.test(disclaimer)) {
    throw new TypeError("Comparison view requires a non-blank disclaimer");
  }
  if (!Array.isArray(comparison.series) || comparison.series.length < 2) {
    throw new RangeError("Comparison series must contain at least two points");
  }

  const validatedAnnotations = (options.annotations ?? []).map(validateDrawingAnnotation);
  const validatedComments = (options.comments ?? []).map(validateCoachingComment);
  const baselineRange = validateEventRange(
    options.baselineEventRange,
    comparison.baselineEventRange,
  );
  const targetRange = validateEventRange(options.targetEventRange, comparison.targetEventRange);
  const durationSec = comparison.baselineEventRange.durationSec;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError("Baseline event duration must be positive and finite");
  }

  let minValue = Infinity;
  let maxValue = -Infinity;
  let previousPercent = -1;
  if (comparison.series[0]?.percent !== 0 || comparison.series.at(-1)?.percent !== 100) {
    throw new RangeError("Comparison series must cover the full [0, 100] interval");
  }
  for (const point of comparison.series) {
    if (!Number.isFinite(point.percent) || point.percent <= previousPercent) {
      throw new RangeError("Comparison series phases must be strictly increasing");
    }
    previousPercent = point.percent;
    const values = [
      point.baselineValue,
      point.targetValue,
      ...(point.referenceLower1Sd !== undefined ? [point.referenceLower1Sd] : []),
      ...(point.referenceUpper1Sd !== undefined ? [point.referenceUpper1Sd] : []),
    ];
    for (const value of values) {
      if (!Number.isFinite(value)) {
        throw new RangeError("Comparison series contains non-finite values");
      }
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
    }
  }

  const mapX = (percent: number) => CHART_LEFT + (CHART_WIDTH * percent) / 100;
  const mapY = (value: number) =>
    minValue === maxValue
      ? CHART_TOP + CHART_HEIGHT / 2
      : CHART_TOP + CHART_HEIGHT - ((value - minValue) / (maxValue - minValue)) * CHART_HEIGHT;

  const baselinePath = comparison.series
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${mapX(point.percent).toFixed(2)} ${mapY(point.baselineValue).toFixed(2)}`,
    )
    .join(" ");
  const targetPath = comparison.series
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${mapX(point.percent).toFixed(2)} ${mapY(point.targetValue).toFixed(2)}`,
    )
    .join(" ");

  const hasReferenceBand = comparison.series.every(
    (point) => point.referenceLower1Sd !== undefined && point.referenceUpper1Sd !== undefined,
  );
  const bandSource = comparison.referenceBandSummary?.source;
  if (hasReferenceBand !== (bandSource !== undefined)) {
    throw new TypeError("Reference band requires complete values and source metadata");
  }
  const referenceCaption =
    bandSource?.kind === "synthetic"
      ? `合成データ（${bandSource.dataset}）`
      : bandSource &&
        `${bandSource.authors.join(", ")} (${bandSource.year}) · ${bandSource.journal} · DOI ${bandSource.doi} · N=${bandSource.sample_size} · ${bandSource.population_notes} · ${bandSource.measurement_modality}`;
  const referenceBandPath = hasReferenceBand
    ? (() => {
        const upper = comparison.series
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${mapX(point.percent).toFixed(2)} ${mapY(point.referenceUpper1Sd as number).toFixed(2)}`,
          )
          .join(" ");
        const lower = [...comparison.series]
          .reverse()
          .map(
            (point) =>
              `L${mapX(point.percent).toFixed(2)} ${mapY(point.referenceLower1Sd as number).toFixed(2)}`,
          )
          .join(" ");
        return `${upper} ${lower} Z`;
      })()
    : "";

  const baselineLabel = escapeHtml(options.baselineLabel ?? comparison.baselineRevisionId);
  const targetLabel = escapeHtml(options.targetLabel ?? comparison.targetRevisionId);
  const escapedDisclaimer = escapeHtml(disclaimer);

  const rateButtons = PLAYBACK_RATES.map((rate) => {
    const label = rate === 1 ? "1.0x" : `${rate}x`;
    const pressed = rate === 1 ? "true" : "false";
    return `<button type="button" class="rate-btn" data-rate="${rate}" aria-pressed="${pressed}">${label}</button>`;
  }).join("");

  const annotationSvg = validatedAnnotations.map(renderAnnotationSvg).join("");
  const commentsHtml = validatedComments
    .map((comment) => {
      const role = escapeHtml(comment.authorRole);
      const body =
        comment.kind === "text"
          ? escapeHtml(comment.text)
          : `音声メモ (${comment.audioDurationSec.toFixed(1)}s)${comment.text ? `: ${escapeHtml(comment.text)}` : ""}`;
      return `<li data-comment-id="${escapeHtml(comment.id)}" data-frame="${comment.frameIndex}"><strong>${role}</strong> (F${comment.frameIndex}): ${body}</li>`;
    })
    .join("");

  const payload: ComparisonViewerPayload = {
    series: comparison.series.map(({ percent, baselineValue, targetValue }) => ({
      percent,
      baselineValue,
      targetValue,
    })),
    baselineRange,
    targetRange,
    durationSec,
    unit: comparison.unit,
  };

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>2試技比較分析</title>${comparisonStyles}</head>
<body><main data-non-diagnostic="true" data-movement="${escapeHtml(comparison.movementType)}" data-metric-id="${escapeHtml(comparison.metricId)}" data-interval-id="${escapeHtml(comparison.intervalId)}" data-rate="1">
<h1>2試技比較分析（0–100%）</h1>
<p id="disclaimer">${escapedDisclaimer}</p>
<section class="panel" aria-labelledby="comparison-heading">
<h2 id="comparison-heading">${escapeHtml(comparison.metricId)}（${escapeHtml(comparison.unit)}）</h2>
<p>Peak Δ: ${comparison.peakDelta.toFixed(1)} ${escapeHtml(comparison.unit)} · 位相ずれ: ${comparison.peakPhaseShiftPercent.toFixed(1)}% · RMS差: ${comparison.rmsDifference.toFixed(2)} ${escapeHtml(comparison.unit)}</p>
<svg id="comparison-chart" viewBox="0 0 344 160" role="img" aria-label="2試技波形比較">
<path d="M16 16 V140 H328" fill="none" stroke="#a4b8be"/>
${hasReferenceBand ? `<path id="reference-band-path" d="${referenceBandPath}" fill="#047c6d" fill-opacity="0.18" stroke="none"/>` : ""}
<path id="baseline-curve" d="${baselinePath}" fill="none" stroke="#182936" stroke-width="2.2"/>
<path id="target-curve" d="${targetPath}" fill="none" stroke="#ba4b2b" stroke-width="2.2"/>
<line id="comparison-cursor" x1="16" y1="12" x2="16" y2="144" stroke="#047c6d" stroke-width="2"/>
</svg>
${referenceCaption ? `<p id="reference-band-source">平均 ± 1 SD · ${escapeHtml(referenceCaption)}</p>` : ""}
<label for="compare-scrubber">正規化フェーズ（0–100%）</label>
<input id="compare-scrubber" type="range" min="0" max="100" step="any" value="0">
<div class="indicators">
<div class="indicator"><div>${baselineLabel}</div><output id="trial-a-indicator" data-percent="0" data-frame="${baselineRange.startFrame}">0%</output></div>
<div class="indicator"><div>${targetLabel}</div><output id="trial-b-indicator" data-percent="0" data-frame="${targetRange.startFrame}">0%</output></div>
</div>
<p>同期差: <output id="sync-delta-indicator" data-sync-delta="0">Δ 0 frame</output></p>
<div id="playback-controls" class="controls" data-rate="1" role="group" aria-label="再生コントロール"><button id="comparison-playback-toggle" type="button">再生</button>${rateButtons}</div>
</section>
<section class="panel" aria-labelledby="annotation-heading">
<h2 id="annotation-heading">ドローイング注釈</h2>
<svg id="annotation-overlay" viewBox="0 0 344 194" role="img" aria-label="コーチング注釈レイヤー">${annotationSvg}</svg>
</section>
${commentsHtml ? `<section id="coaching-comments" class="panel" aria-labelledby="comments-heading"><h2 id="comments-heading">コーチコメント</h2><ul>${commentsHtml}</ul></section>` : ""}
</main>
<script id="comparison-data" type="application/json">${escapeJson(payload)}</script>
<script>(${runComparisonViewer.toString()})(${CHART_LEFT},${CHART_WIDTH});</script>
</body></html>`;
}
