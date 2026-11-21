import { validateContract } from "@sports-motion/contracts";
import {
  InvalidMotionInput,
  type WorkerAnalysisRequest,
  type WorkerAnalysisResult,
} from "./worker.js";

export interface AnalysisSubmission extends Omit<WorkerAnalysisRequest, "analysis_revision_id"> {
  capture_id: string;
  analysis_job_id: string;
}

export interface AnalysisReceipt extends WorkerAnalysisResult {
  analysis_revision_id: string;
  evidence_snapshot_id: string;
}

export class AnalysisConflict extends Error {}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const submissionFields = new Set([
  "capture_id",
  "analysis_job_id",
  "raw_revision_id",
  "movement",
  "views",
  "calibration",
  "revisions",
  "events",
]);

export function parseAnalysisSubmission(body: unknown, trialId: string): AnalysisSubmission {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidMotionInput("Invalid analysis submission");
  }
  const {
    capture_id,
    analysis_job_id,
    raw_revision_id,
    movement,
    views,
    calibration,
    revisions = [],
    events = [],
  } = body as Record<string, unknown>;
  if (
    !Object.keys(body).every((key) => submissionFields.has(key)) ||
    !nonblank(capture_id) ||
    !nonblank(analysis_job_id) ||
    !nonblank(raw_revision_id) ||
    (movement !== "baseball_pitching" && movement !== "running" && movement !== "jump_landing") ||
    !Array.isArray(views) ||
    views.length !== 2 ||
    !validateContract("pose2d", views[0]) ||
    !validateContract("pose2d", views[1]) ||
    views[0].trial_id !== trialId ||
    views[1].trial_id !== trialId ||
    !validateContract("calibration", calibration) ||
    calibration.mode === "monocular_reference" ||
    !Array.isArray(revisions) ||
    !revisions.every((revision) => validateContract("coordinate_revision", revision)) ||
    !Array.isArray(events) ||
    !events.every((event) => validateContract("capture_event", event))
  ) {
    throw new InvalidMotionInput("Invalid analysis submission");
  }
  return {
    capture_id,
    analysis_job_id,
    raw_revision_id,
    movement,
    views: [views[0], views[1]],
    calibration,
    revisions,
    events,
  };
}
