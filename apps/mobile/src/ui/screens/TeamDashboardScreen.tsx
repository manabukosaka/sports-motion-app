import type { KinematicMetrics, Pose3DSequence } from "@sports-motion/contracts";
import {
  buildLongitudinalSeries,
  exportKinematicsCsv,
  exportPose3DToTrc,
  exportWaveformsToMot,
  type LongitudinalQuery,
} from "@sports-motion/export";
import { useState } from "react";
import type { DisclosureMode } from "../mode.js";
import { NonDiagnostic } from "../NonDiagnostic.js";
import { Action, Copy, Notice, Panel, Row } from "../primitives.js";

export interface ExportFile {
  filename: "kinematics.csv" | "pose.trc" | "angles.mot";
  content: string;
}

export interface TeamDashboardScreenProps {
  mode: DisclosureMode;
  organizationName: string;
  teamName: string;
  athleteName: string;
  metricLabel: string;
  query: LongitudinalQuery;
  metrics: KinematicMetrics;
  pose3d?: Pose3DSequence;
  disclaimer_text_ja?: string;
  onExport: (file: ExportFile) => Promise<void>;
}

export function TeamDashboardScreen({
  mode,
  organizationName,
  teamName,
  athleteName,
  metricLabel,
  query,
  metrics,
  pose3d,
  disclaimer_text_ja,
  onExport,
}: TeamDashboardScreenProps) {
  const [status, setStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const { points, summary, unit } = buildLongitudinalSeries(query);
  const trcPose =
    pose3d?.coordinate_frame === "CalibratedWorld3D" && pose3d.is_metric_calibrated
      ? pose3d
      : undefined;
  const save = async (filename: ExportFile["filename"], build: () => string) => {
    if (exporting) return;
    setExporting(true);
    setStatus("");
    try {
      await onExport({ filename, content: build() });
    } catch {
      setStatus("ファイルを出力できませんでした。試技のデータを確認してください。");
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <NonDiagnostic {...(disclaimer_text_ja !== undefined && { disclaimer_text_ja })} />
      <Panel title="選手と試技">
        <Copy>
          {organizationName} › {teamName} › {athleteName}
        </Copy>
        {query.trials.map(({ sessionId, trialId, capturedAt }) => (
          <Copy key={`${sessionId}/${trialId}`}>
            {capturedAt.slice(0, 10)} · セッション {sessionId} › 試技 {trialId}
          </Copy>
        ))}
      </Panel>
      <Panel title={`${metricLabel}の推移`}>
        {points.length === 0 && <Copy>この項目の計測記録はありません。</Copy>}
        {points.map(({ trialId, capturedAt, analysisRevisionId, side, value, unit }, index) => (
          <Copy key={`${analysisRevisionId}-${side ?? "all"}-${index}`}>
            {capturedAt.slice(0, 10)} · {trialId} · {value.toFixed(2)} {unit}
          </Copy>
        ))}
        {summary.deltaFromFirst !== null && (
          <Copy>
            初回との差 {summary.deltaFromFirst.toFixed(2)} {unit}
          </Copy>
        )}
      </Panel>
      {mode === "researcher" && (
        <Panel title="研究用エクスポート">
          <Row>
            <Action
              disabled={exporting}
              onPress={() => void save("kinematics.csv", () => exportKinematicsCsv(metrics))}
            >
              CSV
            </Action>
            <Action
              disabled={exporting || !trcPose}
              onPress={() => trcPose && void save("pose.trc", () => exportPose3DToTrc(trcPose))}
            >
              OpenSim .trc
            </Action>
            <Action
              disabled={exporting}
              onPress={() => void save("angles.mot", () => exportWaveformsToMot(metrics))}
            >
              OpenSim .mot
            </Action>
          </Row>
          {!trcPose && <Copy>実寸で校正した2カメラの試技のみ .trc を出力できます。</Copy>}
          {status && <Notice>{status}</Notice>}
        </Panel>
      )}
    </>
  );
}
