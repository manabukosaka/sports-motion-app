import type {
  CoachingComment,
  CoachingReferenceBand,
  DrawingAnnotation,
} from "@sports-motion/coaching";
import {
  asFrameIndex,
  asSeconds,
  CONTRACT_VERSION,
  type KinematicMetrics,
} from "@sports-motion/contracts";
import { expect, test } from "vitest";
import { CoachingStudioSession } from "../src/index.js";

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
  source: { kind: "synthetic", dataset: "Mobile coaching test trials" },
  points: [
    { percent_0_to_100: 0, mean: 18, sd: 3 },
    { percent_0_to_100: 50, mean: 44, sd: 4 },
    { percent_0_to_100: 100, mean: 16, sd: 3 },
  ],
};

test("CoachingStudioSession coordinates 2-trial comparison, slow-mo synchronized playback, annotations, and comments", () => {
  const session = new CoachingStudioSession({
    baseline: makeTrial("rev-1", 40),
    target: makeTrial("rev-2", 46),
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
    referenceBand,
    baselineTimeline: {
      totalFrames: 120,
      fps: 120,
      startFrame: asFrameIndex(10),
      endFrame: asFrameIndex(90),
    },
    targetTimeline: {
      totalFrames: 240,
      fps: 240,
      startFrame: asFrameIndex(20),
      endFrame: asFrameIndex(180),
    },
  });

  expect(session.comparison.non_diagnostic_flag).toBe(true);
  expect(session.comparison.peakDelta).toBe(6);
  expect(session.comparison.referenceBandSummary).toBeDefined();

  const annotation: DrawingAnnotation = {
    id: "ann-mid",
    kind: "angle",
    startFrame: asFrameIndex(45),
    endFrame: asFrameIndex(55),
    points: [
      { x: 0.3, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.7, y: 0.4 },
    ],
    colorHex: "#047c6d",
  };
  session.addAnnotation(annotation);
  expect(session.visibleAnnotationsAtCurrentFrame()).toHaveLength(0);

  const midState = session.seekPercent(50);
  expect(midState.baselineFrame).toBe(50);
  expect(midState.targetFrame).toBe(100);
  expect(midState.syncDeltaFrames).toBeLessThanOrEqual(1);
  expect(session.visibleAnnotationsAtCurrentFrame().map(({ id }) => id)).toEqual(["ann-mid"]);

  const comment: CoachingComment = {
    id: "cmt-50",
    kind: "text",
    frameIndex: asFrameIndex(50),
    authorRole: "Coach",
    createdAt: "2026-11-20T10:00:00Z",
    text: "Keep hip stable through mid-stance",
  };
  session.addComment(comment);
  expect(session.commentsAtCurrentFrame().map(({ id }) => id)).toEqual(["cmt-50"]);

  expect(session.setPlaybackRate(0.25).rate).toBe(0.25);
  expect(session.stepFrame(1).baselineFrame).toBe(51);
  expect(session.play().playing).toBe(true);
  expect(session.advance(0.1).percent).toBeGreaterThan(50);
  expect(session.pause().playing).toBe(false);

  session.removeAnnotation("ann-mid");
  session.removeComment("cmt-50");
  expect(session.annotations).toHaveLength(0);
  expect(session.comments).toHaveLength(0);
});
