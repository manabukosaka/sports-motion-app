import {
  asMeters,
  asMillimeters,
  type FrameIndex,
  type Millimeters,
  metersToMillimeters,
  type Pose2DSequence,
  type Pose3DSequence,
  type Seconds,
  skeletonGeometry,
} from "@sports-motion/contracts";
import {
  bilateralJoints,
  type Landmark2D,
  landmarksById,
  requireImage2D,
  requireIncreasingTime,
} from "./pose.js";

export type Pose2DAnomaly =
  | "low_confidence"
  | "missing_landmark"
  | "acceleration_spike"
  | "left_right_swap_candidate";

export interface Pose2DQualityFrame {
  frameIndex: FrameIndex;
  timestampSec: Seconds;
  minConfidence: number | null;
  meanConfidence: number | null;
  missingCount: number;
  anomalyFlags: Pose2DAnomaly[];
}

export interface Pose2DInspectionOptions {
  confidenceThreshold?: number;
  accelerationThresholdPxPerSec2?: number;
}

function isVisible(
  point: Landmark2D | undefined,
): point is Extract<Landmark2D, { missing_reason: null }> {
  return point?.missing_reason === null;
}

function hasSwap(previous: Map<string, Landmark2D>, current: Map<string, Landmark2D>) {
  return bilateralJoints.some((joint) => {
    const left = previous.get(`left_${joint}`);
    const right = previous.get(`right_${joint}`);
    const nextLeft = current.get(`left_${joint}`);
    const nextRight = current.get(`right_${joint}`);
    if (!isVisible(left) || !isVisible(right) || !isVisible(nextLeft) || !isVisible(nextRight)) {
      return false;
    }
    const separation = right.x - left.x;
    const nextSeparation = nextRight.x - nextLeft.x;
    return (
      separation * nextSeparation < 0 &&
      (nextLeft.x - left.x) * separation > 0 &&
      (nextRight.x - right.x) * separation < 0
    );
  });
}

export function inspectPose2DQuality(
  pose2d: Pose2DSequence,
  {
    confidenceThreshold = 0.5,
    accelerationThresholdPxPerSec2 = 20_000,
  }: Pose2DInspectionOptions = {},
): Pose2DQualityFrame[] {
  requireImage2D(pose2d);
  requireIncreasingTime(pose2d.frames);
  if (
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1 ||
    !Number.isFinite(accelerationThresholdPxPerSec2) ||
    accelerationThresholdPxPerSec2 < 0
  ) {
    throw new RangeError("Invalid 2D inspection thresholds");
  }
  const frames = pose2d.frames.map((frame) => ({ ...frame, points: landmarksById(frame) }));
  const expected = new Set(
    frames.flatMap(({ landmarks }) => landmarks.map((point) => point.landmark_id)),
  );
  return frames.map(({ frame_index, timestamp_sec, points }, index) => {
    const anomalyFlags: Pose2DAnomaly[] = [];
    let visibleCount = 0;
    let confidenceSum = 0;
    let confidenceCount = 0;
    let minConfidence: number | null = null;
    for (const point of points.values()) {
      if (isVisible(point)) {
        visibleCount += 1;
        if (point.confidence !== null) {
          confidenceSum += point.confidence;
          confidenceCount += 1;
          minConfidence = Math.min(minConfidence ?? 1, point.confidence);
        }
      }
    }
    const missingCount = expected.size - visibleCount;
    if (minConfidence !== null && minConfidence < confidenceThreshold) {
      anomalyFlags.push("low_confidence");
    }
    if (missingCount > 0) {
      anomalyFlags.push("missing_landmark");
    }
    const previous = frames[index - 1];
    const next = frames[index + 1];
    if (previous && next) {
      const beforeSec = timestamp_sec - previous.timestamp_sec;
      const afterSec = next.timestamp_sec - timestamp_sec;
      for (const [id, point] of points) {
        const before = previous.points.get(id);
        const after = next.points.get(id);
        if (!isVisible(before) || !isVisible(point) || !isVisible(after)) {
          continue;
        }
        const deltaVx = (after.x - point.x) / afterSec - (point.x - before.x) / beforeSec;
        const deltaVy = (after.y - point.y) / afterSec - (point.y - before.y) / beforeSec;
        if (
          (2 * Math.hypot(deltaVx, deltaVy)) / (beforeSec + afterSec) >
          accelerationThresholdPxPerSec2
        ) {
          anomalyFlags.push("acceleration_spike");
          break;
        }
      }
    }
    if (previous && hasSwap(previous.points, points)) {
      anomalyFlags.push("left_right_swap_candidate");
    }
    return {
      frameIndex: frame_index,
      timestampSec: timestamp_sec,
      minConfidence,
      meanConfidence: confidenceCount === 0 ? null : confidenceSum / confidenceCount,
      missingCount,
      anomalyFlags,
    };
  });
}

export function inspectBoneLengthAnomalies(
  pose3d: Pose3DSequence,
  { thresholdMm = 15 }: { thresholdMm?: number } = {},
) {
  if (
    pose3d.coordinate_frame !== "CalibratedWorld3D" ||
    pose3d.is_metric_calibrated !== true ||
    pose3d.unit !== "m"
  ) {
    throw new TypeError("Bone length inspection requires CalibratedWorld3D in meters");
  }
  if (!Number.isFinite(thresholdMm) || thresholdMm < 0) {
    throw new RangeError("Invalid bone length threshold in millimeters");
  }
  const tracks = new Map<string, { frameIndex: FrameIndex; lengthMm: Millimeters }[]>();
  for (const frame of pose3d.frames) {
    const { joints, segments } = skeletonGeometry(frame);
    for (const [start, end] of segments) {
      const first = joints[start];
      const second = joints[end];
      if (!first || !second) {
        continue;
      }
      const [from, [x1, y1, z1]] = first;
      const [to, [x2, y2, z2]] = second;
      const segment = `${from}:${to}`;
      const track = tracks.get(segment) ?? [];
      track.push({
        frameIndex: frame.frame_index,
        lengthMm: metersToMillimeters(asMeters(Math.hypot(x2 - x1, y2 - y1, z2 - z1))),
      });
      tracks.set(segment, track);
    }
  }
  return Array.from(tracks, ([segment, samples]) => {
    const sorted = samples.map(({ lengthMm }) => lengthMm).sort((left, right) => left - right);
    const center = (sorted.length - 1) / 2;
    const medianMm = asMillimeters(
      ((sorted[Math.floor(center)] ?? 0) + (sorted[Math.ceil(center)] ?? 0)) / 2,
    );
    const meanMm = asMillimeters(sorted.reduce((sum, length) => sum + length, 0) / sorted.length);
    const sdMm = asMillimeters(
      Math.sqrt(sorted.reduce((sum, length) => sum + (length - meanMm) ** 2, 0) / sorted.length),
    );
    return {
      segment,
      meanMm,
      sdMm,
      medianMm,
      sampleCount: samples.length,
      anomalies: samples.filter(({ lengthMm }) => Math.abs(lengthMm - medianMm) > thresholdMm),
    };
  });
}
