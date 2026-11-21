import {
  type CoordinateRevision,
  type KinematicMetrics,
  type Pose2DSequence,
  type Pose3DSequence,
  validateContract,
} from "@sports-motion/contracts";
import {
  applyCoordinateRevisions,
  type BilateralJoint,
  buildLeftRightSwapRevision,
  buildPointMoveRevision,
  buildRedoRevision,
  buildSplineInterpolationRevision,
  buildUndoRevision,
  type FrameRange,
  inspectPose2DQuality,
  type PointMove,
  type Pose2DInspectionOptions,
  replayCoordinateHistory,
  type SplineRange,
} from "@sports-motion/editing";
import { pathId } from "./path-id.js";

export function computeLoupeViewport(
  touchX: number,
  touchY: number,
  imageWidth: number,
  imageHeight: number,
  zoom = 3,
) {
  if (
    ![touchX, touchY, imageWidth, imageHeight, zoom].every(Number.isFinite) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    zoom < 1
  ) {
    throw new RangeError("Invalid loupe geometry");
  }
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(value, maximum));
  const x = clamp(touchX, imageWidth);
  const y = clamp(touchY, imageHeight);
  const fingertipRadius = Math.min(24, Math.max(imageWidth, imageHeight) / 4);
  const spaces = [
    { side: "above", size: y - fingertipRadius },
    { side: "below", size: imageHeight - y - fingertipRadius },
    { side: "left", size: x - fingertipRadius },
    { side: "right", size: imageWidth - x - fingertipRadius },
  ] as const;
  const preferredSize = Math.min(128, imageWidth, imageHeight);
  const placement =
    spaces.find(({ size }) => size >= preferredSize) ??
    spaces.reduce((largest, candidate) => (candidate.size > largest.size ? candidate : largest));
  const size = Math.min(preferredSize, placement.size);
  const centeredX = clamp(x - size / 2, imageWidth - size);
  const centeredY = clamp(y - size / 2, imageHeight - size);
  const sourceSize = size / zoom;
  const sourceX = clamp(x - sourceSize / 2, imageWidth - sourceSize);
  const sourceY = clamp(y - sourceSize / 2, imageHeight - sourceSize);
  return {
    zoom,
    fingertipRadius,
    viewport: {
      x:
        placement.side === "left"
          ? x - fingertipRadius - size
          : placement.side === "right"
            ? x + fingertipRadius
            : centeredX,
      y:
        placement.side === "above"
          ? y - fingertipRadius - size
          : placement.side === "below"
            ? y + fingertipRadius
            : centeredY,
      width: size,
      height: size,
    },
    source: { x: sourceX, y: sourceY, width: sourceSize, height: sourceSize },
    focalPoint: { x: (x - sourceX) * zoom, y: (y - sourceY) * zoom },
  };
}

export interface EditingApiOptions {
  apiBaseUrl: string;
  teamId: string;
  authToken: string;
}

export interface EditingRecomputeResult {
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  coordinate_revision_id: string;
  current_head: string;
  recompute_ms: number;
  pose3d: Extract<Pose3DSequence, { coordinate_frame: "CalibratedWorld3D" }>;
  kinematic_metrics: KinematicMetrics;
}

export async function commitRevisionAndRecompute(
  options: EditingApiOptions,
  trialId: string,
  revision: CoordinateRevision,
  analysisJobId = revision.revision_id,
): Promise<EditingRecomputeResult> {
  const base = options.apiBaseUrl.replace(/\/+$/u, "");
  const url = `${base}/teams/${pathId(options.teamId)}/trials/${pathId(trialId)}/revisions`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      revision,
      expected_head: revision.expected_head,
      analysis_job_id: analysisJobId,
    }),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Coordinate revision request failed (HTTP ${response.status})`);
  }
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object") {
    throw new TypeError("Invalid recompute response");
  }
  const {
    analysis_revision_id,
    evidence_snapshot_id,
    coordinate_revision_id,
    current_head,
    recompute_ms,
    pose3d,
    kinematic_metrics,
  } = value as Record<string, unknown>;
  if (
    typeof analysis_revision_id !== "string" ||
    !analysis_revision_id.trim() ||
    typeof evidence_snapshot_id !== "string" ||
    !evidence_snapshot_id.trim() ||
    coordinate_revision_id !== revision.revision_id ||
    typeof current_head !== "string" ||
    !current_head.trim() ||
    typeof recompute_ms !== "number" ||
    !Number.isFinite(recompute_ms) ||
    recompute_ms < 0 ||
    !validateContract("pose3d", pose3d) ||
    pose3d.coordinate_frame !== "CalibratedWorld3D" ||
    pose3d.contract_version !== revision.contract_version ||
    pose3d.provenance.coordinate_revision_id !== coordinate_revision_id ||
    !validateContract("kinematic_metrics", kinematic_metrics) ||
    kinematic_metrics.contract_version !== revision.contract_version ||
    kinematic_metrics.analysis_revision_id !== analysis_revision_id ||
    kinematic_metrics.provenance.coordinate_revision_id !== coordinate_revision_id
  ) {
    throw new TypeError("Invalid recompute response");
  }
  return {
    analysis_revision_id,
    evidence_snapshot_id,
    coordinate_revision_id,
    current_head,
    recompute_ms,
    pose3d,
    kinematic_metrics,
  };
}

interface EditingStudioOptions {
  rawRevisionId?: string | null;
  revisions?: readonly CoordinateRevision[];
  inspection?: Pose2DInspectionOptions;
}

function cloneRevision(revision: CoordinateRevision): CoordinateRevision {
  if (revision.operation !== "edit") {
    return { ...revision, edits: [] };
  }
  const copy = (edit: (typeof revision.edits)[number]) => ({
    ...edit,
    landmark: { ...edit.landmark },
  });
  const [first, ...rest] = revision.edits;
  return { ...revision, edits: [copy(first), ...rest.map(copy)] };
}

export class EditingStudioController {
  private readonly raw: Pose2DSequence;
  private readonly history: CoordinateRevision[];
  private readonly rawRevisionId: string | null;
  private committedCount: number;
  private committing: Promise<EditingRecomputeResult | undefined> | undefined;
  private effective: Pose2DSequence;
  private readonly inspection: Pose2DInspectionOptions;

  constructor(rawPose2d: Pose2DSequence, options: EditingStudioOptions = {}) {
    this.raw = applyCoordinateRevisions(rawPose2d, []);
    this.history = options.revisions?.map(cloneRevision) ?? [];
    this.rawRevisionId =
      options.rawRevisionId === undefined
        ? (this.history[0]?.parent_revision_id ?? null)
        : options.rawRevisionId;
    this.committedCount = this.history.length;
    this.effective = applyCoordinateRevisions(this.raw, this.history, this.rawRevisionId);
    this.inspection = { ...options.inspection };
  }

  get rawPose2d() {
    return applyCoordinateRevisions(this.raw, []);
  }

  get effectivePose2d() {
    return applyCoordinateRevisions(this.effective, []);
  }

  get revisions() {
    return this.history.map(cloneRevision);
  }

  get currentHead() {
    return this.replay().currentHead;
  }

  get canUndo() {
    return this.replay().canUndo;
  }

  get canRedo() {
    return this.replay().canRedo;
  }

  get inspectionTimeline() {
    return inspectPose2DQuality(this.effective, this.inspection);
  }

  private replay() {
    return replayCoordinateHistory(this.history, this.raw.contract_version, this.rawRevisionId);
  }

  private stage(revision: CoordinateRevision) {
    if (this.history.some(({ revision_id }) => revision_id === revision.revision_id)) {
      throw new RangeError("Coordinate revision ID is already staged");
    }
    this.effective = applyCoordinateRevisions(
      this.raw,
      [...this.history, revision],
      this.rawRevisionId,
    );
    this.history.push(revision);
    return cloneRevision(revision);
  }

  previewEdit(revisionId: string, moves: readonly PointMove[]) {
    return this.stage(
      buildPointMoveRevision(this.effective, { revisionId, expectedHead: this.currentHead }, moves),
    );
  }

  swapLeftRight(revisionId: string, range: FrameRange, joints?: readonly BilateralJoint[]) {
    return this.stage(
      buildLeftRightSwapRevision(
        this.effective,
        { revisionId, expectedHead: this.currentHead },
        range,
        joints,
      ),
    );
  }

  interpolateRange(revisionId: string, range: SplineRange) {
    return this.stage(
      buildSplineInterpolationRevision(
        this.effective,
        { revisionId, expectedHead: this.currentHead },
        range,
      ),
    );
  }

  undo(revisionId: string) {
    return this.stage(
      buildUndoRevision(this.effective, { revisionId, expectedHead: this.currentHead }),
    );
  }

  redo(revisionId: string) {
    return this.stage(
      buildRedoRevision(this.effective, { revisionId, expectedHead: this.currentHead }),
    );
  }

  commitRevisionAndRecompute(options: EditingApiOptions) {
    if (this.committing) {
      return this.committing;
    }
    const batch = this.history.slice(this.committedCount);
    const commit = async () => {
      let result: EditingRecomputeResult | undefined;
      for (const revision of batch) {
        result = await commitRevisionAndRecompute(options, this.raw.trial_id, revision);
        if (result.current_head !== revision.revision_id) {
          throw new Error("The server coordinate history has advanced");
        }
        this.committedCount += 1;
      }
      return result;
    };
    this.committing = commit().finally(() => {
      this.committing = undefined;
    });
    return this.committing;
  }
}
