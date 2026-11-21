import { type FrameIndex, type Image2DPoint, validateContract } from "@sports-motion/contracts";

export * from "./coaching-studio.js";
export * from "./editing-studio.js";
export { SportsMotionApp, type SportsMotionAppProps } from "./ui/App.js";
export type { DisclosureMode } from "./ui/mode.js";
export * from "./ui/screens/CaptureScreen.js";
export * from "./ui/screens/ComparisonScreen.js";
export * from "./ui/screens/EditingStudioScreen.js";
export * from "./ui/screens/ShareScreen.js";
export * from "./ui/screens/TeamDashboardScreen.js";
export * from "./walking-skeleton.js";

export function readImagePoint(
  value: unknown,
  frameIndex: FrameIndex,
  landmarkId: string,
): Image2DPoint | undefined {
  if (!validateContract("pose2d", value)) {
    return undefined;
  }
  const frame = value.frames.find((frame) => frame.frame_index === frameIndex);
  const landmark = frame?.landmarks.find((landmark) => landmark.landmark_id === landmarkId);
  if (!landmark || landmark.missing_reason !== null) {
    return undefined;
  }
  return { frame: value.coordinate_frame, viewId: value.view_id, x: landmark.x, y: landmark.y };
}
