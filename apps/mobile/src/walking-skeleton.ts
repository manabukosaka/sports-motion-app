import {
  asMeters,
  type CalibrationParams,
  CONTRACT_VERSION,
  type KinematicMetrics,
  type Pose2DSequence,
  type Pose3DSequence,
  skeletonGeometry,
  validateContract,
} from "@sports-motion/contracts";
import { pathId } from "./path-id.js";

type TwoCameraCalibration = Exclude<CalibrationParams, { mode: "monocular_reference" }>;
type Movement = "baseball_pitching" | "running" | "jump_landing";

export interface LocalCapture {
  capture_id: string;
  contract_version: typeof CONTRACT_VERSION;
  views: [Pose2DSequence, Pose2DSequence];
  calibration: TwoCameraCalibration;
  movement: Movement;
  events: KinematicMetrics["events"];
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createLocalCapture({
  capture_id,
  views,
  calibration,
  movement,
  events,
}: {
  capture_id: string;
  views: unknown;
  calibration: unknown;
  movement: Movement;
  events: unknown;
}): LocalCapture {
  if (
    !nonblank(capture_id) ||
    !Array.isArray(views) ||
    views.length !== 2 ||
    !validateContract("pose2d", views[0]) ||
    !validateContract("pose2d", views[1]) ||
    !validateContract("calibration", calibration) ||
    calibration.mode === "monocular_reference" ||
    calibration.contract_version !== CONTRACT_VERSION ||
    views[0].contract_version !== CONTRACT_VERSION ||
    views[1].contract_version !== CONTRACT_VERSION ||
    views[0].trial_id !== views[1].trial_id ||
    views[0].view_id === views[1].view_id ||
    !calibration.views.every(({ view_id }) =>
      [views[0].view_id, views[1].view_id].includes(view_id),
    ) ||
    (movement !== "baseball_pitching" && movement !== "running" && movement !== "jump_landing") ||
    !Array.isArray(events) ||
    !Array.from(events).every((event) => validateContract("capture_event", event))
  ) {
    throw new TypeError("Invalid local capture");
  }
  return {
    capture_id,
    contract_version: CONTRACT_VERSION,
    views: [views[0], views[1]],
    calibration,
    movement,
    events,
  };
}

export function buildSkeletonPreview(pose3d: Pose3DSequence, frameIndex: number) {
  if (pose3d.coordinate_frame !== "CalibratedWorld3D") {
    throw new TypeError("Skeleton preview requires CalibratedWorld3D");
  }
  const frame = pose3d.frames.find(({ frame_index }) => frame_index === frameIndex);
  if (!frame) {
    throw new RangeError("Unknown skeleton frame");
  }
  const { joints, segments } = skeletonGeometry(frame);
  const angleRad = Math.PI / 6;
  return {
    frameIndex: frame.frame_index,
    unit: "m" as const,
    points: joints.map(([landmarkId, [x, y, z]]) => ({
      landmarkId,
      x: asMeters(x * Math.cos(angleRad) - z * Math.sin(angleRad)),
      y: asMeters(-y),
    })),
    segments,
  };
}

interface ClientOptions {
  apiBaseUrl: string;
  teamId: string;
  authToken: string;
}

export interface WalkingSkeletonAnalysis {
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  evidence_registry_version: string;
  non_diagnostic_flag: true;
  disclaimer_text_ja: string;
  pose3d: Extract<Pose3DSequence, { coordinate_frame: "CalibratedWorld3D" }>;
  kinematic_metrics: KinematicMetrics;
}

interface ShareUrlOptions {
  teamId: string;
  analysisRevisionId: string;
  evidenceSnapshotId: string;
  expiresAt: number;
  shareWebBaseUrl: string;
}

export class WalkingSkeletonMobileClient {
  constructor(private readonly options: ClientOptions) {}

  private async post(path: string, body: object): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/+$/u, "")}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Walking Skeleton request failed (HTTP ${response.status})`);
    }
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid Walking Skeleton response");
    }
    return value as Record<string, unknown>;
  }

  async uploadAndAnalyze(capture: LocalCapture): Promise<WalkingSkeletonAnalysis> {
    if (capture.contract_version !== CONTRACT_VERSION) {
      throw new TypeError("Unsupported local capture version");
    }
    const { capture_id, views, calibration, movement, events } = createLocalCapture(capture);
    const receipt = await this.post(
      `/teams/${pathId(this.options.teamId)}/trials/${pathId(views[0].trial_id)}/analyze`,
      {
        capture_id,
        analysis_job_id: capture_id,
        raw_revision_id: capture_id,
        views,
        calibration,
        movement,
        events,
      },
    );
    const {
      analysis_revision_id,
      evidence_snapshot_id,
      evidence_registry_version,
      non_diagnostic_flag,
      disclaimer_text_ja,
      pose3d,
      kinematic_metrics,
    } = receipt;
    if (
      !nonblank(analysis_revision_id) ||
      !nonblank(evidence_snapshot_id) ||
      !nonblank(evidence_registry_version) ||
      non_diagnostic_flag !== true ||
      !nonblank(disclaimer_text_ja) ||
      !validateContract("pose3d", pose3d) ||
      pose3d.coordinate_frame !== "CalibratedWorld3D" ||
      pose3d.contract_version !== CONTRACT_VERSION ||
      pose3d.provenance.calibration_id_or_none !== calibration.calibration_id ||
      pose3d.provenance.coordinate_revision_id !== capture_id ||
      !validateContract("kinematic_metrics", kinematic_metrics) ||
      kinematic_metrics.contract_version !== CONTRACT_VERSION ||
      kinematic_metrics.analysis_revision_id !== analysis_revision_id
    ) {
      throw new TypeError("Invalid Walking Skeleton analysis response");
    }
    return {
      analysis_revision_id,
      evidence_snapshot_id,
      evidence_registry_version,
      non_diagnostic_flag,
      disclaimer_text_ja,
      pose3d,
      kinematic_metrics,
    };
  }

  buildSkeletonPreview(pose3d: Pose3DSequence, frameIndex: number) {
    return buildSkeletonPreview(pose3d, frameIndex);
  }

  async issueShareUrl({
    teamId,
    analysisRevisionId,
    evidenceSnapshotId,
    expiresAt,
    shareWebBaseUrl,
  }: ShareUrlOptions) {
    const { shareLinkId, token } = await this.post(`/teams/${pathId(teamId)}/share-links`, {
      analysisRevisionId,
      evidenceSnapshotId,
      expiresAt,
    });
    if (!nonblank(shareLinkId) || !nonblank(token)) {
      throw new TypeError("Invalid Walking Skeleton share link response");
    }
    const shareUrl = `${shareWebBaseUrl.replace(/\/+$/u, "")}/share/${pathId(shareLinkId)}?token=${encodeURIComponent(token)}`;
    return { shareLinkId, token, shareUrl };
  }
}
