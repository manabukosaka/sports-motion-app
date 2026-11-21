import type { CoachingReferenceBand, TrialPlaybackTimeline } from "@sports-motion/coaching";
import {
  asFrameIndex,
  asMeters,
  asPixels,
  asSeconds,
  asViewId,
  type CalibrationParams,
  CONTRACT_VERSION,
  type CoordinateRevision,
  type KinematicMetrics,
  type Pose2DSequence,
  type Pose3DSequence,
  validateContract,
} from "@sports-motion/contracts";
import { loadEvidenceCatalog } from "@sports-motion/evidence";
import { CoachingStudioSession } from "../coaching-studio.js";
import { type EditingRecomputeResult, EditingStudioController } from "../editing-studio.js";
import { WalkingSkeletonMobileClient } from "../walking-skeleton.js";
import type { SportsMotionAppProps } from "./App.js";
import { saveExportFile } from "./export-file.js";
import type { CaptureMovement } from "./screens/CaptureScreen.js";

type Demo = Omit<SportsMotionAppProps, "capture">;
type PointMeters = readonly [x: number, y: number, z: number];
const fps = 60;
const frameCount = 49;
const provenance: KinematicMetrics["provenance"] = {
  contract_version: CONTRACT_VERSION,
  pipeline_version: "1.0.0",
  stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
  filter_spec_version: "0.2.0",
  calibration_id_or_none: "none",
  coordinate_revision_id: "demo-raw",
};

const definitions = {
  running: {
    title: "ランニング",
    label: "右膝の曲がり",
    movementType: "running",
    metricId: "run_knee_flexion_extension_angle",
    intervalId: "run_stride",
    events: [
      ["run_initial_contact", 0],
      ["run_mid_stance", 9],
      ["run_toe_off", 19],
      ["run_next_initial_contact", 48],
    ],
    scalarEvent: "run_initial_contact",
    angles: [
      [0, 21],
      [0.16, 44],
      [0.35, 20],
      [0.54, 88],
      [0.69, 103],
      [0.85, 42],
      [1, 21],
    ],
  },
  baseball_pitching: {
    title: "野球投球",
    label: "右肘の曲がり",
    movementType: "baseball_pitching",
    metricId: "pitch_elbow_flexion_angle",
    intervalId: "pitch_cycle",
    events: [
      ["pitch_leg_lift", 0],
      ["pitch_foot_contact", 22],
      ["pitch_mer", 30],
      ["pitch_ball_release", 36],
      ["pitch_mir", 48],
    ],
    scalarEvent: "pitch_ball_release",
    angles: [
      [0, 99],
      [0.4, 86],
      [0.62, 112],
      [0.75, 26],
      [0.85, 21],
      [1, 66],
    ],
  },
  jump_landing: {
    title: "ジャンプ・着地",
    label: "右膝の曲がり",
    movementType: "cmj",
    metricId: "jump_landing_knee_flexion_angle",
    intervalId: "cmj_cycle",
    events: [
      ["cmj_initiation", 0],
      ["cmj_peak_flexion", 14],
      ["cmj_takeoff", 20],
      ["cmj_initial_landing_contact", 34],
      ["cmj_peak_landing_flexion", 48],
    ],
    scalarEvent: "cmj_peak_landing_flexion",
    angles: [
      [0, 8],
      [0.29, 85],
      [0.42, 9],
      [0.58, 47],
      [0.71, 19],
      [1, 73],
    ],
  },
} as const satisfies Record<
  CaptureMovement,
  {
    title: string;
    label: string;
    movementType: KinematicMetrics["movement_type"];
    metricId: KinematicMetrics["normalized_waveforms"][number]["metric_id"];
    intervalId: KinematicMetrics["normalized_waveforms"][number]["interval_id"];
    events: readonly (readonly [KinematicMetrics["events"][number]["event_id"], number])[];
    scalarEvent: KinematicMetrics["events"][number]["event_id"];
    angles: readonly (readonly [number, number])[];
  }
>;

function curve(keys: readonly (readonly [number, number])[], phase: number) {
  const next = keys.findIndex(([time]) => time >= phase);
  const right = keys[next] ?? keys.at(-1);
  const left = keys[next - 1];
  if (!left || !right) return right?.[1] ?? 0;
  const weight = (1 - Math.cos((Math.PI * (phase - left[0])) / (right[0] - left[0]))) / 2;
  return left[1] + (right[1] - left[1]) * weight;
}

function timeline(
  metrics: KinematicMetrics,
  totalFrames: number,
  framesPerSecond: number,
): TrialPlaybackTimeline {
  const start = metrics.events[0],
    end = metrics.events.at(-1);
  if (!start || !end) throw new RangeError("Demo metrics require a complete movement interval");
  return {
    totalFrames,
    fps: framesPerSecond,
    startFrame: start.frame_index,
    endFrame: end.frame_index,
  };
}

function makeMetrics(movement: CaptureMovement, id: string, offset: number): KinematicMetrics {
  const def = definitions[movement];
  const metric = {
    metric_id: def.metricId,
    unit: "deg",
    anatomical_plane: "sagittal",
    side: "right",
  } as const;
  const angle = (frame: number) => curve(def.angles, frame / (frameCount - 1)) + offset;
  const point = (frame: number) => ({
    normalized_time_fraction: frame / (frameCount - 1),
    value: angle(frame),
  });
  const scalarFrame = def.events.find(([event]) => event === def.scalarEvent)?.[1] ?? 0;
  return {
    contract_version: CONTRACT_VERSION,
    analysis_revision_id: id,
    movement_type: def.movementType,
    provenance,
    events: def.events.map(([event_id, frame]) => ({
      event_id,
      frame_index: asFrameIndex(frame),
      timestamp_sec: asSeconds(frame / fps),
      detection_mode: "manual",
      ...(movement === "running" && { side: "right" }),
    })),
    scalar_metrics: [
      {
        ...metric,
        event_id: def.scalarEvent,
        value_or_null: angle(scalarFrame),
        missing_reason_or_null: null,
      },
    ],
    normalized_waveforms: [
      {
        ...metric,
        interval_id: def.intervalId,
        points: [
          point(0),
          point(1),
          ...Array.from({ length: frameCount - 2 }, (_, frame) => point(frame + 2)),
        ],
      },
    ],
  };
}

function samplePose(movement: CaptureMovement, phase: number) {
  const tau = 2 * Math.PI;
  const run = movement === "running";
  const pitch = movement === "baseball_pitching";
  const lift = pitch ? Math.sin(Math.PI * Math.min(1, phase / 0.55)) : 0;
  const jump = !run && !pitch;
  const kneeAngle = (time: number) => curve(definitions[movement].angles, time);
  const flight =
    jump && phase > 0.42 && phase < 0.71 ? Math.sin((Math.PI * (phase - 0.42)) / 0.29) * 0.32 : 0;
  const pelvis: PointMeters = [
    0,
    run ? 0.026 * Math.cos(2 * tau * phase) : flight - (jump ? kneeAngle(phase) * 0.0018 : 0),
    0,
  ];
  const theta = pitch
    ? curve(
        [
          [0, -0.25],
          [0.45, -1],
          [0.75, 0.72],
          [1, 1.06],
        ],
        phase,
      )
    : run
      ? 0.18 * Math.sin(tau * phase)
      : 0;
  const offset = (origin: PointMeters, x: number, y: number, z: number): PointMeters => [
    origin[0] + x,
    origin[1] + y,
    origin[2] + z,
  ];
  const stride = (origin: PointMeters, length: number, angle: number) =>
    offset(origin, 0, -length * Math.cos(angle), length * Math.sin(angle));
  const shoulder = (side: number) =>
    offset(
      pelvis,
      side * 0.19 * Math.cos(theta),
      0.49,
      side * 0.19 * Math.sin(theta) + (run ? 0.07 : 0),
    );
  const hip = (side: number) => offset(pelvis, side * 0.105, 0, 0);
  const nose = offset(pelvis, 0, 0.73, 0.09);
  const leg = (side: number, time: number) => {
    const thigh = run
      ? curve(
          [
            [0, 0.43],
            [0.35, -0.36],
            [0.57, -0.23],
            [0.78, 0.64],
            [1, 0.43],
          ],
          time,
        )
      : pitch
        ? side === -1
          ? 1.15 * lift + 0.49 * phase
          : -0.22 * phase
        : (kneeAngle(time) * Math.PI) / 360;
    const flexion =
      ((pitch ? 18 + 68 * lift * (side === -1 ? 1 : 0.25) : kneeAngle(time)) * Math.PI) / 180;
    const knee = stride(hip(side), 0.405, thigh);
    return { knee, ankle: stride(knee, 0.39, thigh - flexion) };
  };
  const arm = (side: number, time: number) => {
    const root = shoulder(side);
    if (pitch && side === 1) {
      const sweep = curve(
        [
          [0, 0],
          [0.4, -1.12],
          [0.62, -0.82],
          [0.75, 1.0],
          [1, 1.72],
        ],
        phase,
      );
      const elbow = offset(
        root,
        0.28 * Math.cos(sweep),
        phase > 0.75 ? -0.11 * (phase - 0.75) : 0,
        0.28 * Math.sin(sweep),
      );
      const flexion = (kneeAngle(phase) * Math.PI) / 180;
      return {
        elbow,
        wrist: offset(
          elbow,
          0.26 * Math.cos(sweep) * Math.cos(flexion),
          0.26 * Math.sin(flexion),
          0.26 * Math.sin(sweep) * Math.cos(flexion),
        ),
      };
    }
    const upper = run
      ? -0.6 * Math.cos(tau * time)
      : jump
        ? -0.6 + 1.7 * Math.sin(Math.PI * phase)
        : 0.4;
    const elbow = stride(root, 0.28, upper);
    return { elbow, wrist: stride(elbow, 0.255, upper + (run ? 1.28 : 0.64)) };
  };
  const opposite = run ? (phase + 0.5) % 1 : phase;
  const left = leg(-1, opposite),
    right = leg(1, phase);
  const leftArm = arm(-1, opposite),
    rightArm = arm(1, phase);
  return {
    nose,
    pelvis,
    left_shoulder: shoulder(-1),
    right_shoulder: shoulder(1),
    left_elbow: leftArm.elbow,
    right_elbow: rightArm.elbow,
    left_wrist: leftArm.wrist,
    right_wrist: rightArm.wrist,
    left_hip: hip(-1),
    right_hip: hip(1),
    left_knee: left.knee,
    right_knee: right.knee,
    left_ankle: left.ankle,
    right_ankle: right.ankle,
    right_foot_index: offset(right.ankle, 0, -0.045, 0.135),
  };
}

function sampleMotion(movement: CaptureMovement) {
  const width = 400,
    height = 252,
    missingFrame = 14;
  const sample = (index: number) => ({
    frame_index: asFrameIndex(index),
    timestamp_sec: asSeconds(index / fps),
    joints: Object.entries(samplePose(movement, index / (frameCount - 1))),
  });
  const first = sample(0);
  const rest = Array.from({ length: frameCount - 1 }, (_, index) => sample(index + 1));
  const rawFrame = ({ joints, ...frame }: typeof first): Pose2DSequence["frames"][number] => ({
    ...frame,
    landmarks: joints.map(([landmark_id, [x, y, z]]) => {
      const point = { landmark_id, source: "tracker_raw" } as const;
      if (frame.frame_index === missingFrame && landmark_id === "right_knee") {
        return { ...point, x: null, y: null, confidence: null, missing_reason: "occluded" };
      }
      return {
        ...point,
        x: asPixels(width / 2 + (x * 0.995 + z * 0.1) * 132),
        y: asPixels(119 - y * 132),
        confidence: 0.97,
        missing_reason: null,
      };
    }),
  });
  const relativeFrame = ({ joints, ...frame }: typeof first): Pose3DSequence["frames"][number] => ({
    ...frame,
    landmarks: joints.map(([landmark_id, [x, y, z]]) => ({
      landmark_id,
      x: asMeters(x),
      y: asMeters(y),
      z: asMeters(z),
      source: "tracker_raw",
      missing_reason: null,
    })),
  });
  const raw: Pose2DSequence = {
    contract_version: CONTRACT_VERSION,
    trial_id: `sample-${movement}`,
    view_id: asViewId("demo-front-oblique"),
    fps,
    width_px: asPixels(width),
    height_px: asPixels(height),
    lens_undistorted: true,
    coordinate_frame: "Image2D",
    unit: "px",
    frames: [rawFrame(first), ...rest.map(rawFrame)],
  };
  const pose3d: Pose3DSequence = {
    coordinate_frame: "HipRelative3D",
    is_metric_calibrated: false,
    contract_version: CONTRACT_VERSION,
    unit: "m",
    provenance,
    bone_length_stability_mm: null,
    frames: [relativeFrame(first), ...rest.map(relativeFrame)],
  };
  return { raw, pose3d };
}

const catalog = loadEvidenceCatalog();
const disclaimer_text_ja = catalog.disclaimer_policy.user_facing_text_ja;

function comparisonFor(
  movement: CaptureMovement,
  baseline: KinematicMetrics,
  target: KinematicMetrics,
  pose3d: Pose3DSequence,
  baselineTimeline: TrialPlaybackTimeline,
  targetTimeline: TrialPlaybackTimeline,
  live: boolean,
): Demo["comparison"] {
  const { metricId, intervalId, label } = definitions[movement];
  const band: CoachingReferenceBand = {
    metric_id: metricId,
    interval_id: intervalId,
    unit: "deg",
    source: {
      kind: "synthetic",
      dataset: live ? "ローカルデモの基準試技を中心とする表示例" : `${label}の表示サンプル`,
    },
    points: (
      baseline.normalized_waveforms.find(
        (wave) => wave.metric_id === metricId && wave.interval_id === intervalId,
      )?.points ?? []
    ).map(({ normalized_time_fraction, value }) => ({
      percent_0_to_100: normalized_time_fraction * 100,
      mean: value,
      sd: 5,
    })),
  };
  const session = new CoachingStudioSession({
    baseline,
    target,
    metricId,
    intervalId,
    baselineTimeline,
    targetTimeline,
    side: "right",
    disclaimerTextJa: disclaimer_text_ja,
    referenceBand: band,
  });
  return {
    session,
    target,
    pose3d,
    catalog,
    metricLabel: label,
    sourceLabel: live ? "Python 3D · 80フレーム" : "サンプル骨格 · 49フレーム",
  };
}

export function createDemo(movement: CaptureMovement = "running"): Demo {
  const { title, label, metricId, scalarEvent } = definitions[movement];
  const trials = [-3, -2, -1, 0].map((offset, index) => {
    const id = index + 1;
    return {
      teamId: "demo-team",
      athleteId: "demo-athlete",
      sessionId: String(id),
      trialId: `demo-${movement}-${id}`,
      capturedAt: new Date(Date.UTC(2026, 10, 1 + index * 7, 9)).toISOString(),
      metrics: makeMetrics(movement, `demo-${movement}-analysis-${id}`, offset),
    };
  });
  const baseline = makeMetrics(movement, `demo-${movement}-analysis-3`, -1);
  const target = makeMetrics(movement, `demo-${movement}-analysis-4`, 0);
  const { raw, pose3d } = sampleMotion(movement);
  return {
    editing: {
      controller: new EditingStudioController(raw, { rawRevisionId: "demo-raw" }),
      pose3d,
      disclaimer_text_ja,
    },
    comparison: comparisonFor(
      movement,
      baseline,
      target,
      pose3d,
      timeline(baseline, frameCount, fps),
      timeline(target, frameCount, fps),
      false,
    ),
    team: {
      organizationName: "青葉スポーツクラブ",
      teamName: title,
      athleteName: "サンプル選手",
      metricLabel: label,
      query: {
        teamId: "demo-team",
        athleteId: "demo-athlete",
        metricId,
        eventId: scalarEvent,
        trials,
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
      title: `${title}のレポート`,
      shareConsent: false,
    },
  };
}

interface LiveDemoConfig {
  apiBaseUrl: "/demo-api";
  teamId: string;
  athleteId: string;
  baselineTrialId: string;
  bearerToken: string;
  shareWebBaseUrl: string;
  rawPose2d: Pose2DSequence;
  rawRevisionId: string;
  revisions: CoordinateRevision[];
  cutoffsHz: NonNullable<Demo["comparison"]["cutoffsHz"]>;
  pose3d: Extract<Pose3DSequence, { coordinate_frame: "CalibratedWorld3D" }>;
  kinematic_metrics: KinematicMetrics;
  baseline_metrics: KinematicMetrics;
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  evidence_registry_version: string;
  disclaimer_text_ja: string;
  calibration: CalibrationParams;
}

export function readLiveDemoConfig(value: unknown): LiveDemoConfig | undefined {
  if (!value || typeof value !== "object") return;
  const config = value as { [K in keyof LiveDemoConfig]?: unknown };
  if (
    config.apiBaseUrl !== "/demo-api" ||
    ![
      "teamId",
      "athleteId",
      "baselineTrialId",
      "rawRevisionId",
      "bearerToken",
      "shareWebBaseUrl",
      "analysis_revision_id",
      "evidence_snapshot_id",
      "evidence_registry_version",
      "disclaimer_text_ja",
    ].every((key) => {
      const field = config[key as keyof LiveDemoConfig];
      return typeof field === "string" && field.trim().length > 0;
    }) ||
    !Array.isArray(config.revisions) ||
    !config.revisions.every((revision) => validateContract("coordinate_revision", revision)) ||
    !config.cutoffsHz ||
    typeof config.cutoffsHz !== "object" ||
    !Object.values(config.cutoffsHz).every(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    ) ||
    !validateContract("pose2d", config.rawPose2d) ||
    !validateContract("pose3d", config.pose3d) ||
    config.pose3d.coordinate_frame !== "CalibratedWorld3D" ||
    !validateContract("kinematic_metrics", config.kinematic_metrics) ||
    config.analysis_revision_id !== config.kinematic_metrics.analysis_revision_id ||
    config.pose3d.provenance.coordinate_revision_id !==
      (config.revisions.at(-1)?.revision_id ?? config.rawRevisionId) ||
    !validateContract("kinematic_metrics", config.baseline_metrics) ||
    !validateContract("calibration", config.calibration)
  )
    return;
  const shareUrl = new URL(String(config.shareWebBaseUrl));
  if (
    shareUrl.protocol !== "http:" ||
    shareUrl.hostname !== "127.0.0.1" ||
    shareUrl.pathname !== "/" ||
    shareUrl.username ||
    shareUrl.password ||
    shareUrl.search ||
    shareUrl.hash
  )
    return;
  return config as unknown as LiveDemoConfig;
}

export function createLiveDemo(
  config: LiveDemoConfig,
  result?: EditingRecomputeResult,
  controller?: EditingStudioController,
): Demo {
  const sample = createDemo();
  const {
    teamId,
    athleteId,
    apiBaseUrl,
    bearerToken: authToken,
    shareWebBaseUrl,
    baseline_metrics: baseline,
    calibration,
  } = config;
  const pose3d = result?.pose3d ?? config.pose3d;
  const metrics = result?.kinematic_metrics ?? config.kinematic_metrics;
  const api = { teamId, apiBaseUrl, authToken };
  const liveTrial = {
    teamId,
    athleteId,
    sessionId: "2",
    trialId: config.rawPose2d.trial_id,
    capturedAt: "2026-11-22T09:00:00Z",
    metrics,
  };
  return {
    editing: {
      controller:
        controller ??
        new EditingStudioController(config.rawPose2d, {
          rawRevisionId: config.rawRevisionId,
          revisions: config.revisions,
        }),
      pose3d,
      api,
      disclaimer_text_ja: config.disclaimer_text_ja,
    },
    comparison: {
      ...comparisonFor(
        "running",
        baseline,
        metrics,
        pose3d,
        timeline(baseline, config.pose3d.frames.length, config.rawPose2d.fps),
        timeline(metrics, pose3d.frames.length, config.rawPose2d.fps),
        true,
      ),
      calibration,
      ...(!result && { cutoffsHz: config.cutoffsHz }),
    },
    team: {
      ...sample.team,
      athleteName: "青葉 はる",
      metrics,
      pose3d,
      query: {
        ...sample.team.query,
        teamId,
        athleteId,
        trials: [
          {
            ...liveTrial,
            sessionId: "1",
            trialId: config.baselineTrialId,
            capturedAt: "2026-11-15T09:00:00Z",
            metrics: baseline,
          },
          liveTrial,
        ],
      },
    },
    share: {
      ...sample.share,
      analysis: {
        analysis_revision_id: result?.analysis_revision_id ?? config.analysis_revision_id,
        evidence_snapshot_id: result?.evidence_snapshot_id ?? config.evidence_snapshot_id,
        evidence_registry_version: config.evidence_registry_version,
        disclaimer_text_ja: config.disclaimer_text_ja,
      },
      connection: { teamId, shareWebBaseUrl, client: new WalkingSkeletonMobileClient(api) },
    },
  };
}
