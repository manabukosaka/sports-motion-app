import { asFrameIndex } from "@sports-motion/contracts";
import { expect, test } from "vitest";
import { readImagePoint } from "../src/index.js";

const pose = {
  contract_version: "1.0.0",
  trial_id: "trial-1",
  view_id: "side",
  fps: 60,
  width_px: 640,
  height_px: 480,
  lens_undistorted: false,
  coordinate_frame: "Image2D",
  unit: "px",
  frames: [
    {
      frame_index: 4,
      timestamp_sec: 0.2,
      landmarks: [
        {
          landmark_id: "hip",
          x: 320,
          y: 240,
          confidence: 0.9,
          source: "tracker_raw",
          missing_reason: null,
        },
        {
          landmark_id: "ankle",
          x: null,
          y: null,
          confidence: null,
          source: "tracker_raw",
          missing_reason: "occluded",
        },
      ],
    },
  ],
};

test("returns a visible point in its original view", () => {
  expect(readImagePoint(pose, asFrameIndex(4), "hip")).toEqual({
    frame: "Image2D",
    viewId: "side",
    x: 320,
    y: 240,
  });
});

test("rejects incompatible pose units and omits missing landmarks", () => {
  expect(readImagePoint({ ...pose, unit: "m" }, asFrameIndex(4), "hip")).toBeUndefined();
  expect(readImagePoint(pose, asFrameIndex(4), "ankle")).toBeUndefined();
});
