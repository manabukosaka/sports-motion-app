import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type EvidenceCatalog, validateContract } from "@sports-motion/contracts";
import fc from "fast-check";
import { test } from "vitest";
import {
  buildWaveformBandComparison,
  compareMetricsAgainstCatalog,
  evaluateMeanSd,
  evaluateMedianIqr,
  evaluateThresholdRange,
  loadEvidenceCatalog,
  type WaveformReferenceBand,
} from "../src/index.js";

const fixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/fixtures/valid/share_report.synthetic_comparison.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
assert.ok(validateContract("share_report", fixture));
const { kinematic_summary: metrics } = fixture;
const [waveform] = metrics.normalized_waveforms;
assert.ok(waveform);

function syntheticCatalog() {
  const catalog = loadEvidenceCatalog();
  const study = {
    id: "synthetic_running",
    domain: "running",
    authors: ["Synthetic fixture author"],
    year: 2026,
    journal: "Synthetic fixture, no publication",
    title: "Synthetic running study",
    doi: "10.0000/synthetic-contract-fixture",
    measurement_modality: "optical_mocap",
    population_notes: "Twenty simulated runners",
    metrics_covered: ["run_knee_flexion_extension_angle"],
    extraction_status: "verified_normative",
    comparability_bias_note: "Synthetic fixture only",
  } satisfies EvidenceCatalog["studies"][number];
  const metric = {
    metric_id: "run_knee_flexion_extension_angle",
    event_id: "run_initial_contact",
    unit: "deg",
    anatomical_plane: "sagittal",
    stat_type: "mean_sd",
    status: "verified_normative",
    sample_size: 20,
    source_doi: study.doi,
    source_locator: "Synthetic fixture, reference row 1",
    cohort_notes: "Synthetic fixture only. Twenty generated samples, one per simulated runner.",
    values: { mean: 20, sd: 4 },
    non_diagnostic_flag: true,
  } satisfies EvidenceCatalog["normative_metrics"][number];
  catalog.studies.push(study);
  catalog.normative_metrics.push(metric);
  return { catalog, study, metric };
}

test("normal CDF and typical band match analytical values", () => {
  const golden = [
    [0, 50, "within_typical"],
    [1, 84.1344746068543, "within_typical"],
    [-1, 15.8655253931457, "within_typical"],
    [1.959964, 97.5, "above_typical"],
    [-2, 2.27501319481792, "below_typical"],
    [6, 99.99999990134124, "above_typical"],
  ] as const;
  for (const [z, expected, band] of golden) {
    const result = evaluateMeanSd(z, { mean: 0, sd: 1 });
    assert.equal(result.zScore, z);
    assert.ok(Math.abs(result.percentile - expected) < 1e-6, JSON.stringify(result));
    assert.equal(result.band, band);
  }
  assert.equal(evaluateMeanSd(18, { mean: 20, sd: 4 }).zScore, -0.5);
  const tail = evaluateMeanSd(-10, { mean: 0, sd: 1 }).percentile;
  assert.ok(Math.abs(tail - 7.619853024160527e-22) < 1e-32);
});

test("normal percentiles are monotone, symmetric, and bounded", () => {
  const zScore = fc.double({ min: -30, max: 30, noNaN: true });
  const percentile = (z: number) => evaluateMeanSd(z, { mean: 0, sd: 1 }).percentile;
  fc.assert(
    fc.property(zScore, zScore, (a, b) => {
      const low = percentile(Math.min(a, b));
      const high = percentile(Math.max(a, b));
      assert.ok(low <= high);
      assert.ok(Number.isFinite(low) && Number.isFinite(high) && low >= 0 && high <= 100);
      assert.ok(Math.abs(percentile(a) + percentile(-a) - 100) < 1e-12);
    }),
    { seed: 52, numRuns: 1000 },
  );
});

test("IQR and threshold classify inclusive boundaries and preserve direction", () => {
  const quartiles = { median: 5, q1: 4, q3: 8 };
  assert.deepEqual(evaluateMedianIqr(3, quartiles), { band: "below_q1", normalizedOffset: -0.5 });
  assert.deepEqual(evaluateMedianIqr(4, quartiles), {
    band: "within_iqr",
    normalizedOffset: -0.25,
  });
  assert.deepEqual(evaluateMedianIqr(8, quartiles), { band: "within_iqr", normalizedOffset: 0.75 });
  assert.deepEqual(evaluateMedianIqr(9, quartiles), { band: "above_q3", normalizedOffset: 1 });
  assert.deepEqual(evaluateMedianIqr(6, { median: 5, q1: 5, q3: 5 }), {
    band: "above_q3",
    normalizedOffset: null,
  });
  const range = { lower: 3, upper: 7 };
  assert.deepEqual(evaluateThresholdRange(1, range), { band: "below_range", signedDistance: -2 });
  for (const observed of [3, 5, 7]) {
    assert.deepEqual(evaluateThresholdRange(observed, range), {
      band: "within_range",
      signedDistance: 0,
    });
  }
  assert.deepEqual(evaluateThresholdRange(8, range), { band: "above_range", signedDistance: 1 });
});

test("scalar statistics reject invalid ranges and non-finite inputs", () => {
  for (const sd of [0, -1, Infinity, NaN]) {
    assert.throws(() => evaluateMeanSd(0, { mean: 0, sd }), RangeError);
  }
  for (const input of [Infinity, -Infinity, NaN]) {
    assert.throws(() => evaluateMeanSd(input, { mean: 0, sd: 1 }), RangeError);
    assert.throws(() => evaluateMeanSd(0, { mean: input, sd: 1 }), RangeError);
    assert.throws(() => evaluateMedianIqr(input, { median: 0, q1: 0, q3: 1 }), RangeError);
    assert.throws(() => evaluateMedianIqr(0, { median: 0, q1: 0, q3: input }), RangeError);
    assert.throws(() => evaluateThresholdRange(input, { lower: 0, upper: 1 }), RangeError);
    assert.throws(() => evaluateThresholdRange(0, { lower: input, upper: 1 }), RangeError);
  }
  assert.throws(() => evaluateMedianIqr(0, { median: 0, q1: 1, q3: 2 }), RangeError);
  assert.throws(() => evaluateMedianIqr(0, { median: 2, q1: 0, q3: 1 }), RangeError);
  assert.throws(() => evaluateThresholdRange(0, { lower: 1, upper: 0 }), RangeError);
});

const reference: WaveformReferenceBand = {
  metric_id: waveform.metric_id,
  unit: waveform.unit,
  interval_id: waveform.interval_id,
  points: [
    { percent_0_to_100: 0, mean: 19, sd: 1 },
    { percent_0_to_100: 50, mean: 24, sd: 6 },
    { percent_0_to_100: 100, mean: 16, sd: 0 },
  ],
};

test("waveform aligns different grids and counts points within the inclusive band", () => {
  const result = buildWaveformBandComparison(waveform, reference);
  assert.deepEqual(result.points, [
    { percent_0_to_100: 0, observed_value: 18, lower_1sd: 18, upper_1sd: 20, in_band: true },
    { percent_0_to_100: 40, observed_value: 43, lower_1sd: 18, upper_1sd: 28, in_band: false },
    { percent_0_to_100: 100, observed_value: 16, lower_1sd: 16, upper_1sd: 16, in_band: true },
  ]);
  assert.equal(result.in_band, 2 / 3);
});

test("waveform rejects mismatched identifiers, incomplete grids, and invalid points", () => {
  const invalid: WaveformReferenceBand[] = [
    { ...reference, unit: "rad" },
    { ...reference, interval_id: "run_stance" },
    { ...reference, metric_id: "run_hip_flexion_extension_angle" },
    { ...reference, points: reference.points.slice(1) },
    {
      ...reference,
      points: [
        { percent_0_to_100: 0, mean: 0, sd: 1 },
        { percent_0_to_100: 0, mean: 0, sd: 1 },
        { percent_0_to_100: 100, mean: 0, sd: 1 },
      ],
    },
    { ...reference, points: reference.points.map((point) => ({ ...point, sd: -1 })) },
    { ...reference, points: reference.points.map((point) => ({ ...point, mean: Infinity })) },
  ];
  for (const band of invalid) {
    assert.throws(() => buildWaveformBandComparison(waveform, band), RangeError);
  }
  const broken = structuredClone(waveform);
  broken.points[0].value = NaN;
  assert.throws(() => buildWaveformBandComparison(broken, reference), RangeError);
  broken.points[0].normalized_time_fraction = 0.1;
  assert.throws(() => buildWaveformBandComparison(broken, reference), RangeError);
});

test("the built-in catalog validates all 26 studies and yields no normative comparisons", () => {
  const catalog = loadEvidenceCatalog();
  assert.ok(validateContract("evidence_catalog", catalog));
  assert.equal(catalog.studies.length, 26);
  assert.deepEqual(compareMetricsAgainstCatalog(metrics, catalog), {
    evidence_comparisons: [],
    checkpoints: [],
  });
  catalog.studies.pop();
  assert.equal(loadEvidenceCatalog().studies.length, 26);
});

test("approved rows produce a valid share report and complete coaching checkpoints", () => {
  const { catalog, study, metric } = syntheticCatalog();
  catalog.normative_metrics.push(
    { ...metric, stat_type: "median_iqr", values: { median: 22, q1: 19, q3: 25 } },
    { ...metric, stat_type: "threshold_range", values: { lower: 15, upper: 25 } },
  );
  const result = compareMetricsAgainstCatalog(metrics, loadEvidenceCatalog(catalog), {
    population: study.population_notes,
    measurement_method: "optical_mocap",
  });
  assert.deepEqual(result.evidence_comparisons[0], fixture.evidence_comparisons[0]);
  assert.ok(
    validateContract("share_report", {
      ...fixture,
      evidence_comparisons: result.evidence_comparisons,
    }),
  );
  assert.equal(result.checkpoints.length, 3);
  for (const {
    coach_summary_ja,
    researcher_detail,
    non_diagnostic_flag,
    disclaimer_text_ja,
  } of result.checkpoints) {
    assert.match(coach_summary_ja, /研究/);
    assert.equal(non_diagnostic_flag, true);
    assert.equal(disclaimer_text_ja, catalog.disclaimer_policy.user_facing_text_ja);
    assert.equal(researcher_detail.study_id, study.id);
    assert.equal(researcher_detail.source_doi, study.doi);
    assert.equal(researcher_detail.sample_size, 20);
    assert.equal(researcher_detail.population, study.population_notes);
    assert.equal(researcher_detail.measurement_method, study.measurement_modality);
  }
  assert.deepEqual(
    result.checkpoints.map(({ researcher_detail }) => researcher_detail.band),
    ["within_typical", "below_q1", "within_range"],
  );
  const detail = result.checkpoints[0]?.researcher_detail;
  assert.ok(detail && "z_score" in detail);
  assert.equal(detail.z_score, -0.5);
  assert.equal(detail.percentile, evaluateMeanSd(18, metric.values).percentile);
  assert.equal(detail.percentile_method, "normal_distribution_estimate");
});

test("eligibility requires verified study and row plus an exact comparison key", () => {
  const { catalog, study, metric } = syntheticCatalog();
  const [scalar] = metrics.scalar_metrics;
  assert.ok(scalar);
  const noMatch = { evidence_comparisons: [], checkpoints: [] };
  const mismatch = [
    { ...scalar, unit: "rad" },
    { ...scalar, anatomical_plane: "frontal" },
    { ...scalar, event_id: "run_toe_off" },
    { ...scalar, metric_id: "run_hip_flexion_extension_angle" },
  ] as const;
  for (const scalar of mismatch) {
    assert.deepEqual(
      compareMetricsAgainstCatalog({ ...metrics, scalar_metrics: [scalar] }, catalog),
      noMatch,
    );
  }
  assert.deepEqual(
    compareMetricsAgainstCatalog({ ...metrics, movement_type: "cmj" }, catalog),
    noMatch,
  );
  assert.deepEqual(
    compareMetricsAgainstCatalog(metrics, catalog, { population: "Different cohort" }),
    noMatch,
  );
  assert.deepEqual(
    compareMetricsAgainstCatalog(metrics, catalog, { measurement_method: "video_2d" }),
    noMatch,
  );
  catalog.studies = catalog.studies.map((row) =>
    row.id === study.id ? { ...row, extraction_status: "cataloged_pending_fulltext" } : row,
  );
  assert.deepEqual(compareMetricsAgainstCatalog(metrics, loadEvidenceCatalog(catalog)), noMatch);
  catalog.studies = catalog.studies.map((row) => (row.id === study.id ? study : row));
  catalog.normative_metrics = [
    {
      ...metric,
      status: "pending_fulltext_extraction",
      sample_size: null,
      source_locator: null,
      cohort_notes: null,
      values: null,
    },
  ];
  assert.deepEqual(compareMetricsAgainstCatalog(metrics, loadEvidenceCatalog(catalog)), noMatch);
});

test("invalid catalogs and orphaned DOI references cannot be loaded", () => {
  const { catalog, study, metric } = syntheticCatalog();
  assert.throws(() => loadEvidenceCatalog({ ...catalog, studies: [] }), TypeError);
  assert.throws(
    () => loadEvidenceCatalog({ ...catalog, studies: [...catalog.studies, study] }),
    TypeError,
  );
  assert.throws(
    () =>
      loadEvidenceCatalog({
        ...catalog,
        normative_metrics: [{ ...metric, source_doi: "10.0000/unregistered" }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      loadEvidenceCatalog({
        ...catalog,
        normative_metrics: [{ ...metric, approval_status: "rejected" }],
      }),
    TypeError,
  );
});
