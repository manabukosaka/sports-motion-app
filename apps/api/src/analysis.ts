import {
  type CoordinateRevision,
  type ShareReportSnapshot,
  validateContract,
} from "@sports-motion/contracts";
import { applyCoordinateRevisions } from "@sports-motion/editing";
import {
  InvalidMotionInput,
  type WorkerAnalysisRequest,
  type WorkerAnalysisResult,
} from "./worker.js";

export interface AnalysisSubmission extends Omit<WorkerAnalysisRequest, "analysis_revision_id"> {
  capture_id: string;
  analysis_job_id: string;
}

export interface AnalysisReceipt extends Omit<WorkerAnalysisResult, "evidence_comparisons"> {
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  evidence_comparisons: ShareReportSnapshot["evidence_comparisons"];
}

export class AnalysisConflict extends Error {}

export interface RevisionCommitReceipt {
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  coordinate_revision_id: string;
  current_head: string;
  recompute_ms: number;
  pose3d: WorkerAnalysisResult["pose3d"];
  kinematic_metrics: WorkerAnalysisResult["kinematic_metrics"];
}

export function parseRevisionCommit(body: unknown) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidMotionInput("Invalid revision commit");
  }
  const { revision, expected_head, analysis_job_id, ...extra } = body as Record<string, unknown>;
  if (
    Object.keys(extra).length > 0 ||
    !validateContract("coordinate_revision", revision) ||
    expected_head !== revision.expected_head ||
    !nonblank(analysis_job_id)
  ) {
    throw new InvalidMotionInput("Invalid revision commit");
  }
  return { revision, analysisJobId: analysis_job_id };
}

export type AnalysisInputs = Omit<WorkerAnalysisRequest, "analysis_revision_id">;

export function validateEditHistory(inputs: AnalysisInputs, revisions: CoordinateRevision[]) {
  const viewIds = new Set(inputs.views.map(({ view_id }) => view_id));
  for (const revision of revisions) {
    for (const edit of revision.edits) {
      if (!viewIds.has(edit.view_id)) {
        throw new InvalidMotionInput("Coordinate edit references an unknown view");
      }
    }
  }
  try {
    for (const view of inputs.views) {
      applyCoordinateRevisions(view, revisions, inputs.raw_revision_id);
    }
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new InvalidMotionInput(error.message);
    }
    throw error;
  }
}

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
