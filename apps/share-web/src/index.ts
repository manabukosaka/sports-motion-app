import { type ShareReportSnapshot, validateContract } from "@sports-motion/contracts";

interface ShareReportViewModel {
  shareLinkId: ShareReportSnapshot["share_link_id"];
  analysisRevisionId: ShareReportSnapshot["analysis_revision_id"];
  nonDiagnostic: ShareReportSnapshot["non_diagnostic_flag"];
  disclaimerText: ShareReportSnapshot["disclaimer_text_ja"];
}

export function shareReportViewModel(value: unknown): ShareReportViewModel | undefined {
  if (!validateContract("share_report", value)) {
    return undefined;
  }
  return {
    shareLinkId: value.share_link_id,
    analysisRevisionId: value.analysis_revision_id,
    nonDiagnostic: value.non_diagnostic_flag,
    disclaimerText: value.disclaimer_text_ja,
  };
}
