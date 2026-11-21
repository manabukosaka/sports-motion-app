import { PLAYBACK_RATES } from "@sports-motion/coaching";
import type {
  CalibrationParams,
  EvidenceCatalog,
  KinematicMetrics,
} from "@sports-motion/contracts";
import { type CoachingCheckpoint, compareMetricsAgainstCatalog } from "@sports-motion/evidence";
import { useEffect, useMemo, useState } from "react";
import type { CoachingStudioSession } from "../../coaching-studio.js";
import type { DisclosureMode } from "../mode.js";
import { NonDiagnostic } from "../NonDiagnostic.js";
import { Action, Copy, Panel, Row, Scrubber } from "../primitives.js";

export interface ComparisonScreenProps {
  mode: DisclosureMode;
  session: CoachingStudioSession;
  target: KinematicMetrics;
  catalog: EvidenceCatalog;
  calibration?: CalibrationParams;
  cutoffsHz?: Readonly<Partial<Record<"high_speed_upper" | "trunk_lower" | "pooled", number>>>;
}

function ResearchCheckpoint({ detail }: { detail: CoachingCheckpoint["researcher_detail"] }) {
  return (
    <>
      <Copy>
        DOI {detail.source_doi} · n = {detail.sample_size} · {detail.source_locator}
      </Copy>
      <Copy>
        {detail.source_authors.join("、")} ({detail.source_year}) · {detail.source_journal}
      </Copy>
      <Copy>
        {detail.population} · {detail.measurement_method}
      </Copy>
      <Copy>{detail.comparability_bias_note}</Copy>
      <Copy>
        計測値 {detail.observed_value} {detail.unit}
      </Copy>
      {"z_score" in detail && (
        <Copy>
          z = {detail.z_score} · percentile = {detail.percentile}%（正規分布による推定）
        </Copy>
      )}
      {detail.stat_type === "mean_sd" && (
        <Copy>
          平均 ±1SD = {detail.reference_values.mean} ± {detail.reference_values.sd} {detail.unit}
        </Copy>
      )}
      {detail.stat_type === "median_iqr" && (
        <Copy>
          IQR = {detail.reference_values.q1}〜{detail.reference_values.q3} {detail.unit} · 中央値{" "}
          {detail.reference_values.median}
        </Copy>
      )}
      {detail.stat_type === "threshold_range" && (
        <Copy>
          参照範囲 {detail.reference_values.lower}〜{detail.reference_values.upper} {detail.unit}
        </Copy>
      )}
    </>
  );
}

export function ComparisonScreen({
  mode,
  session,
  target,
  catalog,
  calibration,
  cutoffsHz,
}: ComparisonScreenProps) {
  const [playback, setPlayback] = useState(() => session.playbackState);
  const comparison = session.comparison;
  const { checkpoints } = useMemo(
    () => compareMetricsAgainstCatalog(target, catalog),
    [target, catalog],
  );
  const provenance = target.provenance;
  const verifiedCalibration =
    calibration?.calibration_id === provenance.calibration_id_or_none ? calibration : undefined;
  const band = comparison.referenceBandSummary;
  useEffect(() => {
    if (!playback.playing) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      setPlayback(session.advance((now - previous) / 1000));
      previous = now;
    }, 32);
    return () => clearInterval(timer);
  }, [playback.playing, session]);
  useEffect(
    () => () => {
      session.pause();
    },
    [session],
  );
  return (
    <>
      <NonDiagnostic disclaimer_text_ja={comparison.disclaimer_text_ja} />
      <Panel title="2試技の比較">
        <Copy>動作の始まりを0%、終わりを100%として比較します。</Copy>
        <Copy>
          基準の試技 · 最大値 {comparison.peakBaseline.value.toFixed(2)} {comparison.unit}（
          {comparison.peakBaseline.percent}%）
        </Copy>
        <Copy>
          今回の試技 · 最大値 {comparison.peakTarget.value.toFixed(2)} {comparison.unit}（
          {comparison.peakTarget.percent}%）
        </Copy>
        <Copy>
          最大値の差 {comparison.peakDelta.toFixed(2)} {comparison.unit} · ピーク時点の差{" "}
          {comparison.peakPhaseShiftPercent.toFixed(1)} pt
        </Copy>
        <Copy>
          {mode === "researcher" ? "RMS差" : "動き全体のずれ"} {comparison.rmsDifference.toFixed(2)}{" "}
          {comparison.unit}
        </Copy>
        <Row>
          {PLAYBACK_RATES.map((rate) => (
            <Action
              key={rate}
              selected={playback.rate === rate}
              onPress={() => setPlayback(session.setPlaybackRate(rate))}
            >
              {`${rate === 1 ? "1.0" : rate}x`}
            </Action>
          ))}
          <Action onPress={() => setPlayback(playback.playing ? session.pause() : session.play())}>
            {playback.playing ? "一時停止" : "再生"}
          </Action>
        </Row>
        <Scrubber
          label="2試技を同時に移動"
          value={playback.percent}
          onChange={(value) => setPlayback(session.seekPercent(value))}
        />
        <Copy>
          {playback.percent.toFixed(1)}% · 基準フレーム {playback.baselineFrame} · 今回フレーム{" "}
          {playback.targetFrame}
        </Copy>
        <Copy>
          描画注釈 {session.visibleAnnotationsAtCurrentFrame().length} /{" "}
          {session.annotations.length} 件
        </Copy>
      </Panel>
      <Panel title="文献との比較">
        <NonDiagnostic disclaimer_text_ja={catalog.disclaimer_policy.user_facing_text_ja} />
        {checkpoints.length === 0 && <Copy>同じ条件で比較できる文献の指標がありません。</Copy>}
        {checkpoints.map(({ coach_summary_ja, researcher_detail }, index) => (
          <Panel
            key={`${researcher_detail.study_id}-${researcher_detail.metric_id}-${researcher_detail.event_id}-${index}`}
            title="フォームの確認ポイント"
          >
            <Copy>{coach_summary_ja}</Copy>
            {mode === "researcher" && <ResearchCheckpoint detail={researcher_detail} />}
          </Panel>
        ))}
        {mode === "researcher" && band && (
          <>
            <Copy>
              ±1SD帯の範囲内 · 基準 {(band.baselineInBandRatio * 100).toFixed(1)}% · 今回{" "}
              {(band.targetInBandRatio * 100).toFixed(1)}%
            </Copy>
            {band.source.kind === "literature" ? (
              <Copy>
                波形の出典 DOI {band.source.doi} · n = {band.source.sample_size}
              </Copy>
            ) : (
              <Copy>波形の出典：合成データ（{band.source.dataset}）</Copy>
            )}
          </>
        )}
      </Panel>
      {mode === "researcher" && (
        <Panel title="解析条件">
          <Copy>pipeline_version {provenance.pipeline_version}</Copy>
          <Copy>filter_spec_version {provenance.filter_spec_version}</Copy>
          <Copy>calibration_id {provenance.calibration_id_or_none}</Copy>
          <Copy>coordinate_revision_id {provenance.coordinate_revision_id}</Copy>
          {verifiedCalibration && verifiedCalibration.mode !== "monocular_reference" ? (
            <>
              <Copy>
                校正確認点の再投影誤差 {verifiedCalibration.held_out_check.reprojection_error_px} px
              </Copy>
              {verifiedCalibration.mode === "dlt_control_poles" ? (
                <>
                  <Copy>
                    確認点の既知長 RMSE {verifiedCalibration.held_out_check.known_distance_rmse_m} m
                  </Copy>
                  {verifiedCalibration.views.map((view) => (
                    <Copy key={view.view_id}>
                      DLT {view.view_id} · [{view.dlt_params.join(", ")}]
                    </Copy>
                  ))}
                </>
              ) : (
                <>
                  <Copy>校正フィット RMS {verifiedCalibration.fit_rms_px} px</Copy>
                  <Copy>回転行列 {JSON.stringify(verifiedCalibration.rotation_matrix)}</Copy>
                  <Copy>並進ベクトル [{verifiedCalibration.translation_m.join(", ")}] m</Copy>
                </>
              )}
            </>
          ) : (
            <Copy>校正確認の記録なし</Copy>
          )}
          {cutoffsHz?.pooled === undefined ? (
            <>
              <Copy>
                カットオフ（高速上肢）
                {cutoffsHz?.high_speed_upper === undefined
                  ? "記録なし"
                  : `${cutoffsHz.high_speed_upper} Hz`}
              </Copy>
              <Copy>
                カットオフ（体幹・下肢）
                {cutoffsHz?.trunk_lower === undefined ? "記録なし" : `${cutoffsHz.trunk_lower} Hz`}
              </Copy>
            </>
          ) : (
            <Copy>カットオフ（共通）{cutoffsHz.pooled} Hz</Copy>
          )}
        </Panel>
      )}
    </>
  );
}
