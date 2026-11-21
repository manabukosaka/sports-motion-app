import {
  type CoachingComment,
  type CoachingReferenceBand,
  compareTwoTrials,
  type DrawingAnnotation,
} from "@sports-motion/coaching";
import {
  asFrameIndex,
  asNormalizedPercent,
  asSeconds,
  CONTRACT_VERSION,
  type KinematicMetrics,
} from "@sports-motion/contracts";
import { expect, test } from "vitest";
import { renderTwoTrialComparisonHtml } from "../src/index.js";

function makeTrial(revisionId: string, peakValue: number): KinematicMetrics {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_revision_id: revisionId,
    movement_type: "running",
    provenance: {
      contract_version: CONTRACT_VERSION,
      pipeline_version: "1.0.0",
      stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
      filter_spec_version: "1.0.0",
      calibration_id_or_none: "calibration-dlt",
      coordinate_revision_id: `coords-${revisionId}`,
    },
    events: [
      {
        event_id: "run_initial_contact",
        frame_index: asFrameIndex(10),
        timestamp_sec: asSeconds(0.1),
        detection_mode: "manual",
        side: "right",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: asFrameIndex(90),
        timestamp_sec: asSeconds(0.9),
        detection_mode: "manual",
        side: "right",
      },
    ],
    scalar_metrics: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        event_id: "run_initial_contact",
        value_or_null: 18,
        unit: "deg",
        anatomical_plane: "sagittal",
        missing_reason_or_null: null,
        side: "right",
      },
    ],
    normalized_waveforms: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        interval_id: "run_stride",
        unit: "deg",
        anatomical_plane: "sagittal",
        side: "right",
        points: [
          { normalized_time_fraction: 0, value: 18 },
          { normalized_time_fraction: 0.4, value: peakValue },
          { normalized_time_fraction: 1, value: 16 },
        ],
      },
    ],
  };
}

const referenceBand: CoachingReferenceBand = {
  metric_id: "run_knee_flexion_extension_angle",
  interval_id: "run_stride",
  unit: "deg",
  source: { kind: "synthetic", dataset: "Comparison view test trials" },
  points: [
    { percent_0_to_100: 0, mean: 19, sd: 2 },
    { percent_0_to_100: 50, mean: 42, sd: 5 },
    { percent_0_to_100: 100, mean: 17, sd: 2 },
  ],
};

test("renders self-contained 2-trial comparison HTML with reference band, controls, annotations, and non-diagnostic notice", () => {
  const comparison = compareTwoTrials({
    baseline: makeTrial("trial-a", 42),
    target: makeTrial("trial-b", 48),
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
    referenceBand,
  });
  const annotations: DrawingAnnotation[] = [
    {
      id: "ann-1",
      kind: "line",
      startFrame: asFrameIndex(10),
      endFrame: asFrameIndex(60),
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.7 },
      ],
      colorHex: "#047c6d",
    },
  ];
  const comments: CoachingComment[] = [
    {
      id: "cmt-1",
      kind: "text",
      frameIndex: asFrameIndex(20),
      authorRole: "Coach",
      createdAt: "2026-11-20T10:00:00Z",
      text: "Good knee drive at mid-stance",
    },
  ];

  const html = renderTwoTrialComparisonHtml({
    comparison,
    annotations,
    comments,
    baselineEventRange: { startFrame: 10, endFrame: 90 },
    targetEventRange: { startFrame: 20, endFrame: 180 },
  });

  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(html).toContain('data-non-diagnostic="true"');
  expect(html).toContain(`<p id="disclaimer">${comparison.disclaimer_text_ja}</p>`);
  expect(html).toContain('id="reference-band-path"');
  expect(html).toContain("合成データ（Comparison view test trials）");
  expect(html).toContain('id="baseline-curve"');
  expect(html).toContain('id="target-curve"');
  expect(html).toContain('id="compare-scrubber"');
  expect(html).toContain('id="trial-a-indicator"');
  expect(html).toContain('id="trial-b-indicator"');
  expect(html).toContain('data-rate="0.1"');
  expect(html).toContain('data-rate="0.25"');
  expect(html).toContain('data-rate="0.5"');
  expect(html).toContain('data-rate="1"');
  expect(html).toContain('id="annotation-overlay"');
  expect(html).toContain("Good knee drive at mid-stance");
});

test("strictly escapes XSS payloads in labels, comments, and disclaimer", () => {
  const comparison = compareTwoTrials({
    baseline: makeTrial("trial-a", 40),
    target: makeTrial("trial-b", 45),
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
  });
  const payload = `</script><img src=x onerror="window.__xss=1"><script>alert('x')</script>`;
  const embeddedUnit = `${payload}&\u2028\u2029`;
  const html = renderTwoTrialComparisonHtml({
    comparison: { ...comparison, unit: embeddedUnit as typeof comparison.unit },
    disclaimerTextJa: payload,
    annotations: [
      {
        id: "ann-xss",
        kind: "label",
        startFrame: asFrameIndex(0),
        endFrame: asFrameIndex(100),
        points: [{ x: 0.4, y: 0.4 }],
        colorHex: "#ba4b2b",
        label: payload,
      },
    ],
    comments: [
      {
        id: "cmt-xss",
        kind: "text",
        frameIndex: asFrameIndex(10),
        authorRole: "Coach",
        createdAt: "2026-11-20T10:00:00Z",
        text: payload,
      },
    ],
  });

  expect(html).not.toContain(payload);
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;");
  const json = /<script id="comparison-data" type="application\/json">([^<]*)<\/script>/u.exec(
    html,
  )?.[1];
  expect(json).toBeDefined();
  expect(json).not.toMatch(/[<>&\u2028\u2029]/u);
  expect(JSON.parse(json ?? "").unit).toBe(embeddedUnit);
});

test("rejects diagnostic or blank-disclaimer comparison inputs", () => {
  const comparison = compareTwoTrials({
    baseline: makeTrial("trial-a", 40),
    target: makeTrial("trial-b", 45),
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
  });
  expect(() =>
    renderTwoTrialComparisonHtml({
      comparison: { ...comparison, non_diagnostic_flag: false as unknown as true },
    }),
  ).toThrow(TypeError);
  expect(() =>
    renderTwoTrialComparisonHtml({
      comparison,
      disclaimerTextJa: "   ",
    }),
  ).toThrow(TypeError);
  expect(() =>
    renderTwoTrialComparisonHtml({
      comparison: {
        ...comparison,
        series: comparison.series.map((point) => ({ ...point, percent: asNormalizedPercent(50) })),
      },
    }),
  ).toThrow(/full \[0, 100\] interval/u);
});
