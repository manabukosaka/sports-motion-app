import {
  asFrameIndex,
  asMeters,
  asPixels,
  asSeconds,
  asViewId,
  CONTRACT_VERSION,
  type Pose2DSequence,
  type Pose3DSequence,
  validateContract,
} from "@sports-motion/contracts";
import fc from "fast-check";
import { expect, test } from "vitest";
import {
  applyCoordinateRevisions,
  buildLeftRightSwapRevision,
  buildPointMoveRevision,
  buildRedoRevision,
  buildSplineInterpolationRevision,
  buildUndoRevision,
  inspectBoneLengthAnomalies,
  inspectPose2DQuality,
  replayCoordinateHistory,
} from "../src/index.js";

type Frame = Pose2DSequence["frames"][number];
const point = (landmark_id: string, x: number, y: number, confidence = 0.9) => ({
  landmark_id,
  x: asPixels(x),
  y: asPixels(y),
  confidence,
  source: "tracker_raw" as const,
  missing_reason: null,
});
const occluded = {
  landmark_id: "left_wrist",
  x: null,
  y: null,
  confidence: 0.1,
  source: "tracker_raw",
  missing_reason: "occluded",
} as const;
const frame = (index: number, sec: number, ...landmarks: Frame["landmarks"]): Frame => ({
  frame_index: asFrameIndex(index),
  timestamp_sec: asSeconds(sec),
  landmarks,
});
const pose = (...frames: Pose2DSequence["frames"]): Pose2DSequence => ({
  contract_version: CONTRACT_VERSION,
  trial_id: "trial",
  view_id: asViewId("side"),
  fps: 60,
  width_px: asPixels(100),
  height_px: asPixels(90),
  lens_undistorted: true,
  coordinate_frame: "Image2D",
  unit: "px",
  frames,
});
const identity = (revisionId: string, expectedHead: string | null = null) => ({
  revisionId,
  expectedHead,
});
const range = (start: number, end = start) => ({
  startFrame: asFrameIndex(start),
  endFrame: asFrameIndex(end),
});

test("inspects confidence, explicit and absent landmarks, acceleration and adjacent swaps", () => {
  const raw = pose(
    frame(0, 0, point("left_knee", 10, 5), point("right_knee", 30, 5), point("left_wrist", 15, 10)),
    frame(4, 0.01, point("left_knee", 31, 5, 0.2), point("right_knee", 11, 5), occluded),
    frame(7, 0.04, point("left_knee", 33, 5), point("right_knee", 13, 5)),
  );
  const timeline = inspectPose2DQuality(raw);
  expect(timeline[1]).toMatchObject({
    frameIndex: 4,
    minConfidence: 0.2,
    missingCount: 1,
    anomalyFlags: [
      "low_confidence",
      "missing_landmark",
      "acceleration_spike",
      "left_right_swap_candidate",
    ],
  });
  expect(timeline[1]?.meanConfidence).toBeCloseTo(0.55);
  expect(timeline[2]?.anomalyFlags).toEqual(["missing_landmark"]);
  expect(
    inspectPose2DQuality(raw, { accelerationThresholdPxPerSec2: 1e7 })[1]?.anomalyFlags,
  ).not.toContain("acceleration_spike");

  const linear = pose(
    frame(0, 0, point("left_knee", 10, 5)),
    frame(1, 0.01, point("left_knee", 11, 5)),
    frame(2, 0.04, point("left_knee", 14, 5)),
  );
  expect(
    inspectPose2DQuality(linear, { accelerationThresholdPxPerSec2: 1 })[1]?.anomalyFlags,
  ).toEqual([]);
  linear.frames[0].timestamp_sec = asSeconds(0.01);
  expect(() => inspectPose2DQuality(linear)).toThrow(RangeError);
});

test("reports calibrated bone lengths in millimeters around a median and rejects HipRelative3D", () => {
  const [first, ...rest] = [0.4, 0.4, 0.43, 0.4].map((length, index) => ({
    frame_index: asFrameIndex(index),
    timestamp_sec: asSeconds(index / 60),
    landmarks: [
      ["right_hip", 0],
      ["right_knee", length],
    ].map(([landmark_id, y]) => ({
      landmark_id: String(landmark_id),
      x: asMeters(0),
      y: asMeters(Number(y)),
      z: asMeters(0),
      source: "tracker_raw" as const,
      missing_reason: null,
    })),
  }));
  if (!first) {
    throw new Error("Missing synthetic frames");
  }
  const sequence: Pose3DSequence = {
    contract_version: CONTRACT_VERSION,
    coordinate_frame: "CalibratedWorld3D",
    is_metric_calibrated: true,
    unit: "m",
    bone_length_stability_mm: null,
    provenance: {
      contract_version: CONTRACT_VERSION,
      pipeline_version: "synthetic",
      stage_models: [{ stage: "reconstructor_3d", model_hash: "fixture", license_tier: "A" }],
      calibration_id_or_none: "fixture",
      coordinate_revision_id: "raw",
      filter_spec_version: "none",
    },
    frames: [first, ...rest],
  };
  expect(inspectBoneLengthAnomalies(sequence)).toEqual([
    {
      segment: "right_hip:right_knee",
      meanMm: 407.5,
      medianMm: 400,
      sdMm: Math.sqrt(168.75),
      sampleCount: 4,
      anomalies: [{ frameIndex: 2, lengthMm: 430 }],
    },
  ]);
  expect(inspectBoneLengthAnomalies(sequence, { thresholdMm: 30 })[0]?.anomalies).toEqual([]);
  expect(() =>
    inspectBoneLengthAnomalies({
      ...sequence,
      is_metric_calibrated: false,
      coordinate_frame: "HipRelative3D",
    }),
  ).toThrow(TypeError);
});

test("moves multiple frames with clamping, and swaps full landmark observations over a range", () => {
  const raw = pose(
    frame(2, 0, point("left_knee", 10, 15), point("right_knee", 30, 25, 0.6)),
    frame(4, 0.02, point("left_knee", 11, 16)),
  );
  const move = buildPointMoveRevision(raw, identity("move"), [
    { frameIndex: asFrameIndex(2), landmarkId: "left_knee", x: asPixels(-8), y: asPixels(101) },
    { frameIndex: asFrameIndex(4), landmarkId: "left_knee", x: asPixels(20), y: asPixels(15) },
  ]);
  expect(validateContract("coordinate_revision", move)).toBe(true);
  const moved = applyCoordinateRevisions(raw, [move]);
  expect(moved.frames[0].landmarks[0]).toMatchObject({ x: 0, y: 90, source: "manual_edit" });
  expect(moved.frames[1]?.landmarks[0]).toMatchObject({ x: 20, y: 15 });
  const swap = buildLeftRightSwapRevision(moved, identity("swap", "move"), range(2, 4), ["knee"]);
  expect(validateContract("coordinate_revision", swap)).toBe(true);
  const swapped = applyCoordinateRevisions(raw, [move, swap]);
  expect(swapped.frames[0].landmarks).toMatchObject([
    { landmark_id: "left_knee", x: 30, confidence: 0.6 },
    { landmark_id: "right_knee", x: 0, y: 90 },
  ]);
  expect(swapped.frames[1]?.landmarks).toMatchObject([
    { landmark_id: "left_knee", x: null, missing_reason: "occluded" },
    { landmark_id: "right_knee", x: 20, missing_reason: null },
  ]);
});

test("recovers a known natural cubic and uses actual seconds with a two-anchor line", () => {
  const raw = pose(
    frame(0, 0, point("left_wrist", 20, 10)),
    frame(1, 0.25, occluded),
    frame(2, 0.75, occluded),
    frame(3, 1, point("left_wrist", 26, 14)),
    frame(4, 2, point("left_wrist", 20, 18)),
  );
  const options = { ...range(1, 2), landmarkId: "left_wrist" };
  const cubic = buildSplineInterpolationRevision(raw, identity("cubic"), options);
  const line = buildSplineInterpolationRevision(raw, identity("line"), {
    ...options,
    anchorFrames: [asFrameIndex(0), asFrameIndex(3)],
  });
  for (const revision of [cubic, line]) {
    expect(validateContract("coordinate_revision", revision)).toBe(true);
    expect(revision.edits.map(({ landmark }) => landmark)).toMatchObject([
      { y: 11, source: "spline_interpolated", missing_reason: null },
      { y: 13, source: "spline_interpolated", missing_reason: null },
    ]);
  }
  expect(line.edits.map(({ landmark }) => landmark.x)).toEqual([21.5, 24.5]);
  expect(cubic.edits.map(({ landmark }) => landmark.x)).toEqual(
    [0.25, 0.75].map((t) => 20 + 9 * t - 3 * t ** 3),
  );
  expect(() =>
    buildSplineInterpolationRevision(raw, identity("bad"), {
      ...options,
      anchorFrames: [asFrameIndex(0), asFrameIndex(2)],
    }),
  ).toThrow(RangeError);
});

test("G6 replays reversibly without byte changes and closes the redo chain after branching", () => {
  fc.assert(
    fc.property(fc.integer({ min: -100, max: 200 }), fc.boolean(), (x, missing) => {
      const raw = pose(frame(0, 0, missing ? occluded : point("left_wrist", 10, 5)));
      const serialized = JSON.stringify(raw);
      const move = buildPointMoveRevision(raw, identity("move"), [
        { frameIndex: asFrameIndex(0), landmarkId: "left_wrist", x: asPixels(x), y: asPixels(12) },
      ]);
      const undo = buildUndoRevision(raw, identity("undo", "move"));
      const redo = buildRedoRevision(raw, identity("redo", "undo"));
      expect(validateContract("coordinate_revision", undo)).toBe(true);
      expect(validateContract("coordinate_revision", redo)).toBe(true);
      const revisionBytes = JSON.stringify([move, undo, redo]);
      expect(JSON.stringify(applyCoordinateRevisions(raw, [move, undo]))).toBe(serialized);
      const edited = applyCoordinateRevisions(raw, [move]);
      expect(JSON.stringify(applyCoordinateRevisions(raw, [move, undo, redo, move]))).toBe(
        JSON.stringify(edited),
      );
      const branch = {
        ...move,
        revision_id: "branch",
        expected_head: "undo",
        parent_revision_id: "undo",
      };
      const history = [move, undo, branch];
      expect(replayCoordinateHistory(history, raw.contract_version)).toMatchObject({
        canUndo: true,
        canRedo: false,
        currentHead: "branch",
      });
      expect(() =>
        applyCoordinateRevisions(raw, [
          ...history,
          { ...redo, expected_head: "branch", parent_revision_id: "branch" },
        ]),
      ).toThrow(/No coordinate edit/u);
      expect(() => applyCoordinateRevisions(raw, [move, redo])).toThrow(/history/u);
      expect(JSON.stringify(raw)).toBe(serialized);
      expect(JSON.stringify([move, undo, redo])).toBe(revisionBytes);
    }),
    { seed: 54, numRuns: 60 },
  );
});
