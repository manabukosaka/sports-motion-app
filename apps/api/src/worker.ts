import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  type CalibrationParams,
  type CoordinateRevision,
  type EvidenceCatalog,
  type KinematicMetrics,
  type Pose2DSequence,
  type Pose3DSequence,
  validateContract,
} from "@sports-motion/contracts";

const repository = new URL("../../../", import.meta.url);
const catalog: EvidenceCatalog = JSON.parse(
  readFileSync(new URL("docs/evidence/initial-literature-catalog.json", repository), "utf8"),
);
const workerEnvironmentKeys = new Set([
  "PATH",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "UV_PROJECT_ENVIRONMENT",
  "UV_CACHE_DIR",
  "UV_PYTHON",
  "UV_PYTHON_INSTALL_DIR",
]);

export interface WorkerAnalysisRequest {
  views: [Pose2DSequence, Pose2DSequence];
  calibration: Exclude<CalibrationParams, { mode: "monocular_reference" }>;
  movement: "baseball_pitching" | "running" | "jump_landing";
  analysis_revision_id: string;
  raw_revision_id: string;
  revisions?: CoordinateRevision[];
  events?: KinematicMetrics["events"];
}

export interface WorkerAnalysisResult {
  pose3d: Pose3DSequence;
  kinematic_metrics: KinematicMetrics;
  selected_cutoffs_hz: Partial<Record<"pooled" | "trunk_lower" | "high_speed_upper", number>>;
  evidence_registry_version: string;
  non_diagnostic_flag: true;
  disclaimer_text_ja: string;
  evidence_comparisons: [];
}

export interface MotionWorker {
  analyze(request: WorkerAnalysisRequest): Promise<WorkerAnalysisResult>;
}

export class InvalidMotionInput extends Error {}

function validCutoffs(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([group, hz]) =>
        ["pooled", "trunk_lower", "high_speed_upper"].includes(group) &&
        typeof hz === "number" &&
        Number.isFinite(hz) &&
        hz > 0,
    )
  );
}

export function validateWorkerResult(
  value: unknown,
  request: WorkerAnalysisRequest,
): value is WorkerAnalysisResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const {
    pose3d: pose,
    kinematic_metrics: metrics,
    selected_cutoffs_hz,
    evidence_registry_version,
    disclaimer_text_ja,
    non_diagnostic_flag,
    evidence_comparisons,
    ...extra
  } = value as Record<string, unknown>;
  const revisions = Array.from(new Set(request.revisions?.map((revision) => revision.revision_id)));
  const movement =
    request.movement === "jump_landing"
      ? request.events?.some(({ event_id }) => event_id.startsWith("dvj_"))
        ? "dvj"
        : "cmj"
      : request.movement;
  return (
    Object.keys(extra).length === 0 &&
    validateContract("pose3d", pose) &&
    validateContract("kinematic_metrics", metrics) &&
    pose.is_metric_calibrated &&
    pose.contract_version === request.calibration.contract_version &&
    pose.contract_version === metrics.contract_version &&
    pose.provenance.calibration_id_or_none === request.calibration.calibration_id &&
    pose.provenance.coordinate_revision_id === (revisions.at(-1) ?? request.raw_revision_id) &&
    isDeepStrictEqual(pose.provenance, metrics.provenance) &&
    metrics.analysis_revision_id === request.analysis_revision_id &&
    metrics.movement_type === movement &&
    isDeepStrictEqual(metrics.events, request.events ?? []) &&
    validCutoffs(selected_cutoffs_hz) &&
    evidence_registry_version === catalog.evidence_registry_version &&
    disclaimer_text_ja === catalog.disclaimer_policy.user_facing_text_ja &&
    non_diagnostic_flag === true &&
    Array.isArray(evidence_comparisons) &&
    evidence_comparisons.length === 0
  );
}

export class UvMotionWorker implements MotionWorker {
  async analyze(request: WorkerAnalysisRequest): Promise<WorkerAnalysisResult> {
    const input = JSON.stringify(request);
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => workerEnvironmentKeys.has(key.toUpperCase())),
      ),
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "uv",
        [
          "run",
          "--project",
          "services/motion-engine",
          "--frozen",
          "python",
          "-m",
          "motion_engine.cli",
          "analyze",
        ],
        { cwd: fileURLToPath(repository), env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        (error, output, stderr) => {
          if (
            error?.code === 2 &&
            stderr.trimEnd().endsWith('{"error": "invalid_analysis_input"}')
          ) {
            reject(new InvalidMotionInput("Motion Engine rejected the analysis input"));
          } else if (error) {
            reject(error);
          } else {
            resolve(output);
          }
        },
      );
      // A worker that exits before reading stdin reports the cause through execFile.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
    const result: unknown = JSON.parse(stdout);
    if (!validateWorkerResult(result, request)) {
      throw new Error("Motion Engine returned an invalid analysis result");
    }
    return result;
  }
}
