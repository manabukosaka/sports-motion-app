import { expect, test } from "vitest";
import { shareReportViewModel } from "../src/index.js";

const report = {
  contract_version: "1.0.0",
  share_link_id: "share-1",
  team_id: "team-1",
  analysis_revision_id: "analysis-1",
  evidence_snapshot_id: "evidence-1",
  evidence_registry_version: "1.0.0",
  issued_at: "2026-11-20T10:00:00Z",
  expires_at: "2026-11-21T10:00:00Z",
  non_diagnostic_flag: true,
  disclaimer_text_ja: "診断には使用できません。",
  kinematic_summary: {
    contract_version: "1.0.0",
    analysis_revision_id: "analysis-1",
    movement_type: "running",
    events: [],
    scalar_metrics: [],
    normalized_waveforms: [],
    provenance: {
      contract_version: "1.0.0",
      pipeline_version: "1.0.0",
      stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
      filter_spec_version: "1.0.0",
      calibration_id_or_none: "none",
      coordinate_revision_id: "coordinates-1",
    },
  },
  evidence_comparisons: [],
};

test("keeps the frozen non-diagnostic notice in the share view", () => {
  expect(shareReportViewModel(report)).toEqual({
    shareLinkId: "share-1",
    analysisRevisionId: "analysis-1",
    nonDiagnostic: true,
    disclaimerText: report.disclaimer_text_ja,
  });
});

test("rejects reports with the non-diagnostic flag disabled", () => {
  expect(shareReportViewModel({ ...report, non_diagnostic_flag: false })).toBeUndefined();
});
