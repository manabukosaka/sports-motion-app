import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateContract } from "@sports-motion/contracts";
import type { AccessState } from "../src/index.js";

export const trialId = "trial-a";
const timestamp = (frame: number) => frame / 60;

export function calibratedPayload() {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL("../../../packages/contracts/fixtures/valid/calibration.dlt.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(validateContract("calibration", fixture) && fixture.mode === "dlt_control_poles");
  const calibration = { ...fixture, contract_version: "1.0.0" };
  const landmarks = [
    ["right_hip", 0, 1, 0],
    ["right_knee_left_epicondyle", -0.04, 0.6, 0],
    ["right_knee_right_epicondyle", 0.04, 0.6, 0],
    ["right_ankle_left_malleolus", -0.03, 0.2, 0.16],
    ["right_ankle_right_malleolus", 0.03, 0.2, 0.16],
  ] as const;
  const views = calibration.views.map(({ view_id, dlt_params: p }) => ({
    contract_version: "1.0.0",
    trial_id: trialId,
    view_id,
    fps: 60,
    width_px: 1920,
    height_px: 1080,
    lens_undistorted: true,
    coordinate_frame: "Image2D",
    unit: "px",
    frames: Array.from({ length: 80 }, (_, frame_index) => ({
      frame_index,
      timestamp_sec: timestamp(frame_index),
      landmarks: landmarks.map(([landmark_id, x_m, y_m, z_m]) => {
        const x = x_m + 0.02 * Math.sin(frame_index / 10);
        const denominator = p[8] * x + p[9] * y_m + p[10] * z_m + 1;
        return {
          landmark_id,
          x: (p[0] * x + p[1] * y_m + p[2] * z_m + p[3]) / denominator,
          y: (p[4] * x + p[5] * y_m + p[6] * z_m + p[7]) / denominator,
          confidence: 1,
          source: "tracker_raw",
          missing_reason: null,
        };
      }),
    })),
  }));
  return {
    views,
    calibration,
    capture_id: "capture-a",
    analysis_job_id: "job-a",
    raw_revision_id: "raw-a",
    movement: "running",
    events: [
      {
        event_id: "run_initial_contact",
        frame_index: 8,
        timestamp_sec: timestamp(8),
        detection_mode: "manual",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: 62,
        timestamp_sec: timestamp(62),
        detection_mode: "manual",
      },
    ],
  };
}

export function state(): AccessState {
  return {
    teams: ["a", "b"].map((id) => ({ id, teamId: id, orgId: `org-${id}`, name: id })),
    athletes: ["athlete-a", "other"].map((id) => ({
      id,
      teamId: "a",
      name: id,
      shareConsent: true,
    })),
    trials: [
      { id: trialId, teamId: "a", athleteId: "athlete-a", title: "Run" },
      { id: "trial-other", teamId: "a", athleteId: "other", title: "Run" },
    ],
    memberships: [
      { userId: "coach-a", teamId: "a", role: "Coach", active: true },
      { userId: "coach-b", teamId: "b", role: "Coach", active: true },
      { userId: "guardian-a", teamId: "a", role: "Guardian", active: true },
      { userId: "athlete-other", teamId: "a", role: "Athlete", active: true, athleteId: "other" },
      { userId: "athlete-a", teamId: "a", role: "Athlete", active: true, athleteId: "athlete-a" },
    ],
    guardians: [{ userId: "guardian-a", teamId: "a", athleteId: "athlete-a", active: true }],
    analyses: [],
    evidence: [],
    links: [],
  };
}
