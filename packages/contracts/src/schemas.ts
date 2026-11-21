import evidence from "../../../docs/evidence/evidence-record.schema.json" with { type: "json" };
import calibration from "../schemas/calibration-params.schema.json" with { type: "json" };
import common from "../schemas/common.schema.json" with { type: "json" };
import kinematicAndShare from "../schemas/kinematic-and-share-report.schema.json" with {
  type: "json",
};
import pose2d from "../schemas/pose-2d-sequence.schema.json" with { type: "json" };
import pose3d from "../schemas/pose-3d-sequence.schema.json" with { type: "json" };

const evidenceId = "https://sports-motion-app.invalid/evidence/evidence-record.schema.json";
export const schemas = new Map<string, Record<string, unknown>>([
  [common.$id, common],
  [calibration.$id, calibration],
  [pose2d.$id, pose2d],
  [pose3d.$id, pose3d],
  [kinematicAndShare.$id, kinematicAndShare],
  [evidenceId, evidence],
]);

export const schemaRefs = {
  pose2d: `${pose2d.$id}#/$defs/Pose2DSequence`,
  coordinate_revision: `${pose2d.$id}#/$defs/CoordinateRevision`,
  calibration: calibration.$id,
  pose3d: pose3d.$id,
  kinematic_metrics: `${kinematicAndShare.$id}#/$defs/KinematicMetrics`,
  share_report: `${kinematicAndShare.$id}#/$defs/ShareReportSnapshot`,
  evidence_catalog: evidenceId,
};
