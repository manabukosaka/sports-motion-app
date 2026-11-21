import { readFileSync } from "node:fs";
import { type ContractKind, type ContractTypes, validateContract } from "@sports-motion/contracts";
import { expect, test } from "vitest";
import {
  buildLongitudinalSeries,
  exportKinematicsCsv,
  exportPose3DToTrc,
  exportWaveformsToMot,
  type LongitudinalTrial,
} from "../src/index.js";

function fixture<Kind extends ContractKind>(kind: Kind, name: string): ContractTypes[Kind] {
  const path = new URL(`../../contracts/fixtures/valid/${name}.json`, import.meta.url);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validateContract(kind, value)) {
    throw new Error(`Invalid test fixture ${name}`);
  }
  return value;
}

test("CSV preserves provenance and round-trips scalar data including missing values", () => {
  const metrics = fixture("kinematic_metrics", "kinematic_metrics");
  const csv = exportKinematicsCsv({ ...metrics, analysis_revision_id: '改訂,"A"\n# fake' });
  const lines = Buffer.from(csv, "utf8").toString("utf8").split("\n");
  expect(lines.slice(0, 5)).toEqual([
    "# contract_version=0.1.0",
    "# pipeline_version=0.1.0",
    '# analysis_revision_id="改訂,""A""\\n# fake"',
    "# movement_type=running",
    "# filter_spec_version=0.1.0",
  ]);
  const [header, first, second] = lines
    .slice(5)
    .filter(Boolean)
    .map((row) => row.split(","));
  expect(header).toEqual(["metric_id", "event_id", "value", "unit", "missing_reason"]);
  expect(first).toEqual([
    "run_knee_flexion_extension_angle",
    "run_initial_contact",
    "18",
    "deg",
    "",
  ]);
  expect(second).toEqual([
    "run_ankle_dorsiflexion_plantarflexion_angle",
    "run_initial_contact",
    "",
    "deg",
    "occluded",
  ]);
  expect(csv).not.toMatch(/\r|NaN|Infinity/u);
  const scalar = metrics.scalar_metrics[0];
  if (!scalar) throw new Error("Expected a scalar fixture");
  expect(() =>
    exportKinematicsCsv({
      ...metrics,
      scalar_metrics: [{ ...scalar, value_or_null: Infinity, missing_reason_or_null: null }],
    }),
  ).toThrow(TypeError);
});

test.each([
  ["m", 1],
  ["mm", 1000],
] as const)("TRC in %s preserves frames, marker columns and missing triples", (units, scale) => {
  const pose = fixture("pose3d", "pose3d.world");
  const [first, second] = pose.frames;
  if (!second) throw new Error("Expected two pose frames");
  const hip = second.landmarks[0];
  if (!hip) throw new Error("Expected a hip observation");
  second.landmarks.push({ ...hip, landmark_id: "left_hip" });
  const trc = exportPose3DToTrc(pose, { units });
  const rows = trc.split("\n").map((row) => row.split("\t"));
  expect(rows[0]).toEqual(["PathFileType", "4", "(X/Y/Z)", "pose.trc"]);
  expect(rows[1]).toEqual([
    "DataRate",
    "CameraRate",
    "NumFrames",
    "NumMarkers",
    "Units",
    "OrigDataRate",
    "OrigDataStartFrame",
    "OrigNumFrames",
  ]);
  const rate = String(
    (second.frame_index - first.frame_index) / (second.timestamp_sec - first.timestamp_sec),
  );
  expect(rows[2]).toEqual([rate, rate, "2", "3", units, rate, "1", "3"]);
  expect(rows[3]).toEqual([
    "Frame#",
    "Time",
    "right_hip",
    "",
    "",
    "right_knee",
    "",
    "",
    "left_hip",
    "",
    "",
  ]);
  expect(rows[4]).toEqual(["", "", "X1", "Y1", "Z1", "X2", "Y2", "Z2", "X3", "Y3", "Z3"]);
  expect(rows[5]).toEqual([""]);
  expect(rows[6]?.slice(0, 2)).toEqual(["1", "0"]);
  expect(rows[6]?.slice(2, 8).map(Number)).toEqual(
    [0.15, 0.68, 0.08, 0.185, 1.094, 0.08].map((input) => input * scale),
  );
  expect(rows[6]?.slice(8)).toEqual(["", "", ""]);
  expect(rows[7]?.slice(0, 2)).toEqual(["3", "0.016667"]);
  expect(rows[7]?.slice(5, 8)).toEqual(["", "", ""]);
  expect(rows[7]?.slice(8).map(Number)).toEqual([0.152, 0.68, 0.08].map((input) => input * scale));
  expect(trc).not.toMatch(/NaN|Infinity/u);
});

test("TRC rejects hip-relative 3D and does not invent a missing frame rate", () => {
  const hip = fixture("pose3d", "pose3d.hip");
  expect(() => exportPose3DToTrc(hip)).toThrow(TypeError);
  const pose = fixture("pose3d", "pose3d.world");
  expect(() => exportPose3DToTrc({ ...pose, frames: [pose.frames[0]] })).toThrow(TypeError);
});

test("MOT produces aligned angle-only degree columns on a uniform percent axis", () => {
  const metrics = fixture("kinematic_metrics", "kinematic_metrics");
  const angle = metrics.normalized_waveforms[0];
  if (!angle) throw new Error("Expected an angle waveform fixture");
  metrics.normalized_waveforms.push(
    {
      ...angle,
      side: "left",
      unit: "rad",
      points: [
        { normalized_time_fraction: 0, value: 0 },
        { normalized_time_fraction: 1, value: Math.PI },
      ],
    },
    { ...angle, unit: "deg_per_s" },
  );
  const mot = exportWaveformsToMot(metrics);
  const [header, body] = mot.split("\nendheader\n");
  expect(header?.split("\n")).toEqual([
    "Normalized kinematics (percent_0_to_100)",
    "version=1",
    "nRows=3",
    "nColumns=3",
    "inDegrees=yes",
  ]);
  const [labels, ...rows] =
    body
      ?.trimEnd()
      .split("\n")
      .map((row) => row.split("\t")) ?? [];
  expect(labels).toEqual([
    "time",
    "run_knee_flexion_extension_angle.run_stride.right",
    "run_knee_flexion_extension_angle.run_stride.left",
  ]);
  expect(rows.map((row) => row.map(Number))).toEqual([
    [0, 18, 0],
    [50, 38.5, 90],
    [100, 16, 180],
  ]);
  expect(mot).not.toMatch(/NaN|Infinity/u);
});

test("MOT rejects duplicate times and an export without any angle data", () => {
  const metrics = fixture("kinematic_metrics", "kinematic_metrics");
  const angle = metrics.normalized_waveforms[0];
  if (!angle) throw new Error("Expected an angle waveform fixture");
  expect(() => exportWaveformsToMot({ ...metrics, normalized_waveforms: [] })).toThrow(TypeError);
  angle.points[1].normalized_time_fraction = angle.points[0].normalized_time_fraction;
  expect(() => exportWaveformsToMot(metrics)).toThrow(TypeError);
});

const query = {
  teamId: "team-1",
  athleteId: "athlete-1",
  metricId: "run_knee_flexion_extension_angle",
  eventId: "run_initial_contact",
} as const;

function trial(trialId: string, capturedAt: string, value: number | null): LongitudinalTrial {
  const metrics = fixture("kinematic_metrics", "kinematic_metrics");
  metrics.scalar_metrics = [
    {
      metric_id: query.metricId,
      event_id: query.eventId,
      anatomical_plane: "sagittal",
      unit: "deg",
      ...(value === null
        ? { value_or_null: null, missing_reason_or_null: "occluded" }
        : { value_or_null: value, missing_reason_or_null: null }),
    },
  ];
  return {
    teamId: query.teamId,
    athleteId: query.athleteId,
    sessionId: `session-${trialId}`,
    trialId,
    capturedAt,
    metrics,
  };
}

test("longitudinal summaries use chronological non-missing points and population SD", () => {
  const trials = [
    trial("last", "2026-11-21T11:00:00+09:00", 12),
    trial("middle", "2026-11-21T01:00:00Z", 16),
    trial("first", "2026-11-20T00:00:00Z", 8),
    trial("missing", "2026-11-22T00:00:00Z", null),
  ];
  const series = buildLongitudinalSeries({ ...query, trials });
  expect(series.unit).toBe("deg");
  expect(series.points.map(({ trialId, value }) => [trialId, value])).toEqual([
    ["first", 8],
    ["middle", 16],
    ["last", 12],
  ]);
  expect(series.points[0]).toMatchObject({
    sessionId: "session-first",
    analysisRevisionId: "analysis-running-dlt",
  });
  expect(series.summary).toEqual({
    count: 3,
    latest: 12,
    best: 16,
    deltaFromFirst: 4,
    mean: 12,
    sd: Math.sqrt(32 / 3),
  });
  expect(trials.map(({ trialId }) => trialId)).toEqual(["last", "middle", "first", "missing"]);
  expect(buildLongitudinalSeries({ ...query, eventId: "run_toe_off", trials })).toMatchObject({
    unit: null,
    points: [],
    summary: { count: 0, latest: null, best: null, deltaFromFirst: null, mean: null, sd: null },
  });
});

test.each([
  "teamId",
  "athleteId",
] as const)("longitudinal summaries reject mismatched %s even on missing points", (scope) => {
  const first = trial("first", "2026-11-20T00:00:00Z", 8);
  const foreign = { ...trial("foreign", first.capturedAt, null), [scope]: "other" };
  expect(() => buildLongitudinalSeries({ ...query, trials: [first, foreign] })).toThrow(/scope/u);
});

test("longitudinal summaries reject mismatched units", () => {
  const first = trial("first", "2026-11-20T00:00:00Z", 8);
  const different = trial("different", "2026-11-21T00:00:00Z", 1);
  const scalar = different.metrics.scalar_metrics[0];
  if (!scalar) throw new Error("Expected a scalar fixture");
  scalar.unit = "rad";
  expect(() => buildLongitudinalSeries({ ...query, trials: [first, different] })).toThrow(/units/u);
});
