import type { Pose2DSequence } from "@sports-motion/contracts";

export const bilateralJoints = ["knee", "ankle", "elbow", "wrist", "hip", "shoulder"] as const;
export type BilateralJoint = (typeof bilateralJoints)[number];
export type Frame2D = Pose2DSequence["frames"][number];
export type Landmark2D = Frame2D["landmarks"][number];

export function requireImage2D(pose: Pose2DSequence) {
  if (pose.coordinate_frame !== "Image2D" || pose.unit !== "px") {
    throw new TypeError("Coordinate editing requires Image2D in pixels");
  }
}

export function requireIncreasingTime(frames: Pose2DSequence["frames"]) {
  let previousSec = -Infinity;
  for (const { timestamp_sec } of frames) {
    if (!Number.isFinite(timestamp_sec) || timestamp_sec <= previousSec) {
      throw new RangeError("Frame timestamps must increase in seconds");
    }
    previousSec = timestamp_sec;
  }
}

export function landmarksById(frame: Frame2D) {
  return new Map(frame.landmarks.map((point) => [point.landmark_id, point]));
}
