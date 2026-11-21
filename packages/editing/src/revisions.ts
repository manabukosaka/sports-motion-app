import {
  asPixels,
  type CoordinateRevision,
  type FrameIndex,
  type Pixels,
  type Pose2DSequence,
  validateContract,
} from "@sports-motion/contracts";
import {
  type BilateralJoint,
  bilateralJoints,
  type Landmark2D,
  landmarksById,
  requireImage2D,
  requireIncreasingTime,
} from "./pose.js";
import { naturalSpline } from "./spline.js";

type EditRevision = Extract<CoordinateRevision, { operation: "edit" }>;
type Edit = EditRevision["edits"][number];

export interface RevisionIdentity {
  revisionId: string;
  expectedHead: string | null;
}

export interface FrameRange {
  startFrame: FrameIndex;
  endFrame: FrameIndex;
}

export interface PointMove {
  frameIndex: FrameIndex;
  landmarkId: string;
  x: Pixels;
  y: Pixels;
}

export interface SplineRange extends FrameRange {
  landmarkId: string;
  anchorFrames?: readonly FrameIndex[];
}

function sameEdit(first: Edit, second: Edit) {
  const a = first.landmark;
  const b = second.landmark;
  return (
    first.view_id === second.view_id &&
    first.frame_index === second.frame_index &&
    a.landmark_id === b.landmark_id &&
    a.x === b.x &&
    a.y === b.y &&
    a.confidence === b.confidence &&
    a.missing_reason === b.missing_reason &&
    a.source === b.source
  );
}

export function replayCoordinateHistory(
  revisions: readonly CoordinateRevision[],
  contractVersion: string,
  initialHead: string | null = revisions[0]?.parent_revision_id ?? null,
) {
  let currentHead = initialHead;
  const active: EditRevision[] = [];
  const undone: EditRevision[] = [];
  const committed = new Map<string, CoordinateRevision>();
  for (const revision of revisions) {
    if (!validateContract("coordinate_revision", revision)) {
      throw new TypeError("Invalid coordinate revision");
    }
    const existing = committed.get(revision.revision_id);
    if (existing) {
      if (
        existing.contract_version !== revision.contract_version ||
        existing.operation !== revision.operation ||
        existing.parent_revision_id !== revision.parent_revision_id ||
        existing.expected_head !== revision.expected_head ||
        existing.edits.length !== revision.edits.length ||
        !revision.edits.every((edit, i) => {
          const previous = existing.edits[i];
          return previous !== undefined && sameEdit(previous, edit);
        })
      ) {
        throw new RangeError("Coordinate revision ID is already in use");
      }
      continue;
    }
    if (
      revision.contract_version !== contractVersion ||
      revision.revision_id === initialHead ||
      revision.parent_revision_id !== currentHead ||
      revision.expected_head !== currentHead
    ) {
      throw new RangeError("Coordinate revision does not match the current history");
    }
    if (revision.operation === "edit") {
      active.push(revision);
      undone.length = 0;
    } else {
      const [from, to] = revision.operation === "undo" ? [active, undone] : [undone, active];
      const edit = from.pop();
      if (!edit) {
        throw new RangeError(`No coordinate edit to ${revision.operation}`);
      }
      to.push(edit);
    }
    currentHead = revision.revision_id;
    committed.set(currentHead, revision);
  }
  return { currentHead, active, canUndo: active.length > 0, canRedo: undone.length > 0 };
}

export function applyCoordinateRevisions(
  rawPose2d: Pose2DSequence,
  revisions: readonly CoordinateRevision[],
  initialHead?: string | null,
): Pose2DSequence {
  requireImage2D(rawPose2d);
  const { active } = replayCoordinateHistory(revisions, rawPose2d.contract_version, initialHead);
  const frames = new Map(rawPose2d.frames.map((frame) => [frame.frame_index, frame]));
  for (const revision of revisions) {
    for (const edit of revision.edits) {
      if (edit.view_id === rawPose2d.view_id && !frames.has(edit.frame_index)) {
        throw new RangeError("Coordinate edit references an unknown frame");
      }
    }
  }
  const replacements = new Map<FrameIndex, Map<string, Landmark2D>>();
  for (const revision of active) {
    for (const edit of revision.edits) {
      if (edit.view_id !== rawPose2d.view_id) {
        continue;
      }
      const points = replacements.get(edit.frame_index) ?? new Map<string, Landmark2D>();
      points.set(edit.landmark.landmark_id, edit.landmark);
      replacements.set(edit.frame_index, points);
    }
  }
  const [first, ...remaining] = rawPose2d.frames;
  const applyToFrame = (frame: typeof first) => {
    const updates = replacements.get(frame.frame_index);
    if (!updates) {
      return { ...frame, landmarks: frame.landmarks.map((landmark) => ({ ...landmark })) };
    }
    const points = landmarksById(frame);
    if (points.size !== frame.landmarks.length) {
      throw new RangeError("Coordinate edit references a frame with duplicate landmarks");
    }
    for (const [id, landmark] of updates) {
      points.set(id, landmark);
    }
    return { ...frame, landmarks: Array.from(points.values(), (landmark) => ({ ...landmark })) };
  };
  return { ...rawPose2d, frames: [applyToFrame(first), ...remaining.map(applyToFrame)] };
}

function revisionBase(pose: Pose2DSequence, { revisionId, expectedHead }: RevisionIdentity) {
  requireImage2D(pose);
  if (revisionId === expectedHead) {
    throw new RangeError("Coordinate revision ID must differ from its parent");
  }
  return {
    contract_version: pose.contract_version,
    revision_id: revisionId,
    expected_head: expectedHead,
    parent_revision_id: expectedHead,
  };
}

function validated(revision: CoordinateRevision) {
  if (!validateContract("coordinate_revision", revision)) {
    throw new TypeError("Invalid coordinate revision");
  }
  return revision;
}

function editRevision(pose: Pose2DSequence, identity: RevisionIdentity, edits: Edit[]) {
  const [first, ...rest] = edits;
  if (!first) {
    throw new RangeError("A coordinate edit must change at least one point");
  }
  return validated({ ...revisionBase(pose, identity), operation: "edit", edits: [first, ...rest] });
}

function clampPixels(value: number, upper: Pixels) {
  return asPixels(Math.max(0, Math.min(asPixels(value), upper)));
}

function positioned(
  pose: Pose2DSequence,
  landmark_id: string,
  x: number,
  y: number,
  source: "manual_edit" | "spline_interpolated",
): Landmark2D {
  return {
    landmark_id,
    x: clampPixels(x, pose.width_px),
    y: clampPixels(y, pose.height_px),
    confidence: null,
    source,
    missing_reason: null,
  };
}

export function buildPointMoveRevision(
  pose: Pose2DSequence,
  identity: RevisionIdentity,
  moves: readonly PointMove[],
): CoordinateRevision {
  const frameIndices = new Set(pose.frames.map(({ frame_index }) => frame_index));
  return editRevision(
    pose,
    identity,
    moves.map((move) => {
      if (!frameIndices.has(move.frameIndex)) {
        throw new RangeError("Point move references an unknown frame");
      }
      return {
        frame_index: move.frameIndex,
        view_id: pose.view_id,
        landmark: positioned(pose, move.landmarkId, move.x, move.y, "manual_edit"),
      };
    }),
  );
}

function framesInRange(pose: Pose2DSequence, { startFrame, endFrame }: FrameRange) {
  const frames = pose.frames.filter(
    ({ frame_index }) => frame_index >= startFrame && frame_index <= endFrame,
  );
  if (frames[0]?.frame_index !== startFrame || frames.at(-1)?.frame_index !== endFrame) {
    throw new RangeError("Invalid coordinate edit frame range");
  }
  return frames;
}

export function buildLeftRightSwapRevision(
  pose: Pose2DSequence,
  identity: RevisionIdentity,
  range: FrameRange,
  joints: readonly BilateralJoint[] = bilateralJoints,
): CoordinateRevision {
  const edits: Edit[] = [];
  for (const frame of framesInRange(pose, range)) {
    const points = landmarksById(frame);
    for (const joint of new Set(joints)) {
      if (!bilateralJoints.includes(joint)) {
        throw new RangeError("Unknown bilateral joint");
      }
      const left = points.get(`left_${joint}`);
      const right = points.get(`right_${joint}`);
      if (!left && !right) {
        continue;
      }
      for (const [landmark_id, other] of [
        [`left_${joint}`, right],
        [`right_${joint}`, left],
      ] as const) {
        const landmark: Landmark2D = other
          ? { ...other, landmark_id, source: "manual_edit" }
          : {
              landmark_id,
              x: null,
              y: null,
              confidence: null,
              source: "manual_edit",
              missing_reason: "occluded",
            };
        edits.push({ frame_index: frame.frame_index, view_id: pose.view_id, landmark });
      }
    }
  }
  return editRevision(pose, identity, edits);
}

export function buildSplineInterpolationRevision(
  pose: Pose2DSequence,
  identity: RevisionIdentity,
  range: SplineRange,
): CoordinateRevision {
  requireIncreasingTime(pose.frames);
  const targets = framesInRange(pose, range);
  const candidates = pose.frames.flatMap(({ frame_index, timestamp_sec, landmarks }) => {
    const point = landmarks.find(({ landmark_id }) => landmark_id === range.landmarkId);
    return point?.missing_reason === null &&
      (point.source === "manual_edit" ||
        (point.source === "tracker_raw" && (point.confidence ?? 0) >= 0.5))
      ? [{ frame_index, timestamp_sec, x: point.x, y: point.y }]
      : [];
  });
  const before = candidates.filter(({ frame_index }) => frame_index < range.startFrame);
  const after = candidates.filter(({ frame_index }) => frame_index > range.endFrame);
  const requested = range.anchorFrames && new Set(range.anchorFrames);
  const anchors = requested
    ? [...before, ...after].filter(({ frame_index }) => requested.has(frame_index))
    : [...before.slice(-2), ...after.slice(0, 2)];
  if (
    (requested && anchors.length !== requested.size) ||
    !anchors.some(({ frame_index }) => frame_index < range.startFrame) ||
    !anchors.some(({ frame_index }) => frame_index > range.endFrame)
  ) {
    throw new RangeError("Spline interpolation requires clean anchors on both sides of the range");
  }
  const times = anchors.map(({ timestamp_sec }) => timestamp_sec);
  const xAt = naturalSpline(
    times,
    anchors.map(({ x }) => x),
  );
  const yAt = naturalSpline(
    times,
    anchors.map(({ y }) => y),
  );
  return editRevision(
    pose,
    identity,
    targets.map(({ frame_index, timestamp_sec }) => ({
      view_id: pose.view_id,
      frame_index,
      landmark: positioned(
        pose,
        range.landmarkId,
        xAt(timestamp_sec),
        yAt(timestamp_sec),
        "spline_interpolated",
      ),
    })),
  );
}

function historyRevision(
  pose: Pose2DSequence,
  identity: RevisionIdentity,
  operation: "undo" | "redo",
) {
  if (identity.expectedHead === null) {
    throw new RangeError(`Cannot ${operation} without a parent revision`);
  }
  const head = identity.expectedHead;
  return validated({
    ...revisionBase(pose, identity),
    expected_head: head,
    parent_revision_id: head,
    operation,
    edits: [],
  });
}

export const buildUndoRevision = (pose: Pose2DSequence, identity: RevisionIdentity) =>
  historyRevision(pose, identity, "undo");

export const buildRedoRevision = (pose: Pose2DSequence, identity: RevisionIdentity) =>
  historyRevision(pose, identity, "redo");
