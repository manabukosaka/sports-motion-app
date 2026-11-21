import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { schemaRefs, schemas } from "./schemas.js";
import { timestampKey } from "./timestamps.js";
import type {
  CalibrationParams,
  CoordinateRevision,
  EvidenceCatalog,
  KinematicMetrics,
  Pose2DSequence,
  Pose3DSequence,
  ShareReportSnapshot,
} from "./types.js";

export interface ContractTypes {
  pose2d: Pose2DSequence;
  coordinate_revision: CoordinateRevision;
  calibration: CalibrationParams;
  pose3d: Pose3DSequence;
  kinematic_metrics: KinematicMetrics;
  share_report: ShareReportSnapshot;
  evidence_catalog: EvidenceCatalog;
}

export type ContractKind = keyof ContractTypes;
export const CONTRACT_VERSION = "1.0.0";

const ajv = new Ajv2020({
  strict: true,
  strictTypes: false,
  strictRequired: false,
  ownProperties: true,
});
addFormats.default(ajv);
ajv.addFormat("date-time", (value) => timestampKey(value) !== undefined);

for (const [id, schema] of schemas) {
  ajv.addSchema(schema, id);
}

function compile<Kind extends ContractKind>(kind: Kind) {
  return ajv.compile<ContractTypes[Kind]>({ $ref: schemaRefs[kind] });
}

const pose2dSchema = compile("pose2d");
const pose3dSchema = compile("pose3d");
const calibrationSchema = compile("calibration");
const shareReportSchema = compile("share_report");

function increasingFrames(frames: Pose2DSequence["frames"] | Pose3DSequence["frames"]) {
  return frames.every((frame, index) => {
    const previous = frames[index - 1];
    return (
      previous === undefined ||
      (frame.frame_index > previous.frame_index && frame.timestamp_sec > previous.timestamp_sec)
    );
  });
}

const validators = {
  pose2d: (value: unknown) => pose2dSchema(value) && increasingFrames(value.frames),
  coordinate_revision: compile("coordinate_revision"),
  calibration: (value: unknown) =>
    calibrationSchema(value) &&
    (value.mode === "monocular_reference" || value.views[0].view_id !== value.views[1].view_id),
  pose3d: (value: unknown) => pose3dSchema(value) && increasingFrames(value.frames),
  kinematic_metrics: compile("kinematic_metrics"),
  share_report: (value: unknown) => {
    if (
      !shareReportSchema(value) ||
      value.analysis_revision_id !== value.kinematic_summary.analysis_revision_id
    ) {
      return false;
    }
    const issued = timestampKey(value.issued_at);
    const expires = timestampKey(value.expires_at);
    return (
      issued !== undefined &&
      expires !== undefined &&
      (expires.wholeSecond > issued.wholeSecond ||
        (expires.wholeSecond === issued.wholeSecond && expires.fraction > issued.fraction))
    );
  },
  evidence_catalog: compile("evidence_catalog"),
} satisfies Record<ContractKind, (value: unknown) => boolean>;

export function validateContract<Kind extends ContractKind>(
  kind: Kind,
  value: unknown,
): value is ContractTypes[Kind] {
  return validators[kind](value);
}
