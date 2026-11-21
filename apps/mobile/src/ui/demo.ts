import {
  asFrameIndex,
  asMeters,
  asPixels,
  asSeconds,
  asViewId,
  CONTRACT_VERSION,
  type KinematicMetrics,
  type Pose2DSequence,
  type Pose3DSequence,
} from "@sports-motion/contracts";
import { loadEvidenceCatalog } from "@sports-motion/evidence";
import { CoachingStudioSession } from "../coaching-studio.js";
import { EditingStudioController } from "../editing-studio.js";
import type { SportsMotionAppProps } from "./App.js";
import { saveExportFile } from "./export-file.js";

const provenance: KinematicMetrics["provenance"] = {
  contract_version: CONTRACT_VERSION,
  pipeline_version: "1.0.0",
  stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
  filter_spec_version: "0.2.0",
  calibration_id_or_none: "none",
  coordinate_revision_id: "demo-raw",
};
const metricId = "run_knee_flexion_extension_angle";
const eventId = "run_initial_contact";
const intervalId = "run_stride";
const metric = {
  metric_id: metricId,
  unit: "deg",
  anatomical_plane: "sagittal",
  side: "right",
} as const;

function makeMetrics(id: string, contactAngle: number, peakAngle: number): KinematicMetrics {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_revision_id: id,
    movement_type: "running",
    provenance,
    events: [
      {
        event_id: eventId,
        frame_index: asFrameIndex(0),
        timestamp_sec: asSeconds(0),
        detection_mode: "manual",
        side: "right",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: asFrameIndex(48),
        timestamp_sec: asSeconds(0.8),
        detection_mode: "manual",
        side: "right",
      },
    ],
    scalar_metrics: [
      { ...metric, event_id: eventId, value_or_null: contactAngle, missing_reason_or_null: null },
    ],
    normalized_waveforms: [
      {
        ...metric,
        interval_id: intervalId,
        points: [
          { normalized_time_fraction: 0, value: contactAngle },
          { normalized_time_fraction: 0.5, value: peakAngle },
          { normalized_time_fraction: 1, value: contactAngle },
        ],
      },
    ],
  };
}

function rawFrame(index: number, missing: boolean): Pose2DSequence["frames"][number] {
  return {
    frame_index: asFrameIndex(index),
    timestamp_sec: asSeconds(index / 60),
    landmarks: [
      {
        landmark_id: "left_knee",
        x: asPixels(156),
        y: asPixels(178),
        confidence: 0.4,
        source: "tracker_raw",
        missing_reason: null,
      },
      missing
        ? {
            landmark_id: "right_knee",
            x: null,
            y: null,
            confidence: null,
            source: "tracker_raw",
            missing_reason: "occluded",
          }
        : {
            landmark_id: "right_knee",
            x: asPixels(188 + index),
            y: asPixels(180),
            confidence: 0.95,
            source: "tracker_raw",
            missing_reason: null,
          },
    ],
  };
}

export function createDemo(): Omit<SportsMotionAppProps, "capture"> {
  const catalog = loadEvidenceCatalog();
  const disclaimer_text_ja = catalog.disclaimer_policy.user_facing_text_ja;
  const baseline = makeMetrics("demo-analysis-1", 18, 42);
  const target = makeMetrics("demo-analysis-2", 21, 46);
  const timeline = {
    totalFrames: 49,
    fps: 60,
    startFrame: asFrameIndex(0),
    endFrame: asFrameIndex(48),
  };
  const raw: Pose2DSequence = {
    contract_version: CONTRACT_VERSION,
    trial_id: "demo-2",
    view_id: asViewId("demo-side"),
    fps: 60,
    width_px: asPixels(360),
    height_px: asPixels(240),
    lens_undistorted: true,
    coordinate_frame: "Image2D",
    unit: "px",
    frames: [rawFrame(0, false), rawFrame(1, true), rawFrame(2, false)],
  };
  const relativeFrame = (frameIndex: number): Pose3DSequence["frames"][number] => ({
    frame_index: asFrameIndex(frameIndex),
    timestamp_sec: asSeconds(frameIndex / 60),
    landmarks: [
      {
        landmark_id: "right_knee",
        x: asMeters(0.1),
        y: asMeters(0.4),
        z: asMeters(0),
        source: "tracker_raw",
        missing_reason: null,
      },
    ],
  });
  const pose3d: Pose3DSequence = {
    coordinate_frame: "HipRelative3D",
    is_metric_calibrated: false,
    contract_version: CONTRACT_VERSION,
    unit: "m",
    provenance,
    frames: [relativeFrame(0), relativeFrame(1)],
    bone_length_stability_mm: null,
  };
  const session = new CoachingStudioSession({
    baseline,
    target,
    metricId,
    intervalId,
    baselineTimeline: timeline,
    targetTimeline: timeline,
    disclaimerTextJa: disclaimer_text_ja,
    referenceBand: {
      metric_id: metricId,
      interval_id: intervalId,
      unit: "deg",
      source: { kind: "synthetic", dataset: "ランニングの表示サンプル" },
      points: [
        { percent_0_to_100: 0, mean: 19, sd: 3 },
        { percent_0_to_100: 50, mean: 43, sd: 4 },
        { percent_0_to_100: 100, mean: 19, sd: 3 },
      ],
    },
  });
  const scope = { teamId: "demo-team", athleteId: "demo-athlete" } as const;
  return {
    notice: "デモデータを表示中",
    editing: {
      controller: new EditingStudioController(raw, { rawRevisionId: "demo-raw" }),
      pose3d,
      disclaimer_text_ja,
    },
    comparison: { session, target, catalog },
    team: {
      organizationName: "デモクラブ",
      teamName: "ランニング班",
      athleteName: "デモ選手",
      metricLabel: "接地時の膝の曲がり",
      query: {
        ...scope,
        metricId,
        eventId,
        trials: [
          {
            ...scope,
            sessionId: "1",
            trialId: "demo-1",
            capturedAt: "2026-11-01T09:00:00Z",
            metrics: baseline,
          },
          {
            ...scope,
            sessionId: "2",
            trialId: "demo-2",
            capturedAt: "2026-11-08T09:00:00Z",
            metrics: target,
          },
        ],
      },
      metrics: target,
      pose3d,
      disclaimer_text_ja,
      onExport: saveExportFile,
    },
    share: {
      analysis: {
        analysis_revision_id: target.analysis_revision_id,
        evidence_snapshot_id: "demo-evidence",
        evidence_registry_version: catalog.evidence_registry_version,
        disclaimer_text_ja,
      },
      shareConsent: false,
    },
  };
}
