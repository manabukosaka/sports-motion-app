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
import {
  Action,
  Copy,
  Grid,
  GuideBanner,
  Notice,
  Panel,
  Row,
  StatCard,
  Title,
  TrendChart,
} from "../primitives.js";

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
      <Title subtitle={`${organizationName} › ${teamName} › ${athleteName}`}>チーム管理</Title>
      <GuideBanner badge="記録">
        過去の試技から、選手の動作の変化を確認できます。詳細解析をONにするとデータを出力できます。
      </GuideBanner>
      <Grid layout="split">
        <Panel title={`${metricLabel}の推移`}>
          {points.length === 0 && <Copy>この項目の計測記録がありません。</Copy>}
          <TrendChart points={points} unit={unit ?? ""} />
          {summary.deltaFromFirst !== null && (
            <StatCard
              label="初回との差"
              value={`${summary.deltaFromFirst > 0 ? "+" : ""}${summary.deltaFromFirst.toFixed(2)}`}
              unit={unit ?? ""}
            />
          )}
        </Panel>
        <Panel title="選手と試技">
          {query.trials.length === 0 && <Copy>この選手の試技がありません。</Copy>}
          {query.trials.map(({ sessionId, trialId, capturedAt }) => (
            <Panel
              key={`${sessionId}/${trialId}`}
              title={`${capturedAt.slice(0, 10)} · 試技 ${sessionId}`}
            >
              {points
                .filter((point) => point.trialId === trialId)
                .map(({ side, value, unit }, index) => (
                  <Copy key={`${side ?? "all"}-${index}`}>
                    {metricLabel} · {value.toFixed(2)} {unit}
                  </Copy>
                ))}
              {mode === "researcher" && <Copy>{trialId}</Copy>}
            </Panel>
          ))}
        </Panel>
      </Grid>
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
      <NonDiagnostic {...(disclaimer_text_ja !== undefined && { disclaimer_text_ja })} />
    </>
  );
}
