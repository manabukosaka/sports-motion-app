import { useEffect, useRef, useState } from "react";
import type {
  WalkingSkeletonAnalysis,
  WalkingSkeletonMobileClient,
} from "../../walking-skeleton.js";
import { NonDiagnostic } from "../NonDiagnostic.js";
import { Action, Copy, Link, Notice, Panel, Row } from "../primitives.js";

const presets = [
  { label: "24時間", seconds: 24 * 60 * 60 },
  { label: "7日間", seconds: 7 * 24 * 60 * 60 },
  { label: "30日間", seconds: 30 * 24 * 60 * 60 },
] as const;

export interface ShareScreenProps {
  analysis: Pick<
    WalkingSkeletonAnalysis,
    | "analysis_revision_id"
    | "evidence_snapshot_id"
    | "evidence_registry_version"
    | "disclaimer_text_ja"
  >;
  shareConsent: boolean;
  connection?: {
    teamId: string;
    shareWebBaseUrl: string;
    client: Pick<WalkingSkeletonMobileClient, "issueShareUrl">;
  };
}

export async function issueSharePreview(
  { shareConsent, connection, analysis }: ShareScreenProps,
  preset: (typeof presets)[number]["label"],
  now = Date.now(),
) {
  if (shareConsent !== true) throw new Error("Athlete share consent is required");
  if (!connection) throw new Error("Share service is unavailable");
  const duration = presets.find(({ label }) => label === preset);
  if (!duration) throw new RangeError("Invalid share expiration preset");
  const expiresAt = now + duration.seconds * 1000;
  const { shareUrl, shareLinkId, token } = await connection.client.issueShareUrl({
    teamId: connection.teamId,
    analysisRevisionId: analysis.analysis_revision_id,
    evidenceSnapshotId: analysis.evidence_snapshot_id,
    expiresAt,
    shareWebBaseUrl: connection.shareWebBaseUrl,
  });
  const baseUrl = connection.shareWebBaseUrl.replace(/\/+$/u, "");
  const summaryCardUrl = `${baseUrl}/share/${encodeURIComponent(shareLinkId)}/card.svg?token=${encodeURIComponent(token)}`;
  const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(shareUrl)}`;
  return { shareUrl, summaryCardUrl, lineUrl, expiresAt };
}

export function ShareScreen(props: ShareScreenProps) {
  const { analysis, shareConsent, connection } = props;
  const identity = JSON.stringify([
    connection?.teamId,
    connection?.shareWebBaseUrl,
    analysis.analysis_revision_id,
    analysis.evidence_snapshot_id,
    analysis.evidence_registry_version,
  ]);
  return (
    <>
      <NonDiagnostic disclaimer_text_ja={analysis.disclaimer_text_ja} />
      <Panel title="LINE共有プレビュー">
        <Copy>解析版（analysis_revision_id） {analysis.analysis_revision_id}</Copy>
        <Copy>文献データ版（evidence_registry_version） {analysis.evidence_registry_version}</Copy>
        {shareConsent === true ? (
          <ShareActions key={identity} {...props} />
        ) : (
          <>
            <Notice>選手の共有同意が必要です。</Notice>
            <Action disabled onPress={() => undefined}>
              共有リンクを発行
            </Action>
          </>
        )}
      </Panel>
    </>
  );
}

function ShareActions(props: ShareScreenProps) {
  const [preset, setPreset] = useState<(typeof presets)[number]["label"]>("24時間");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof issueSharePreview>>>();
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(false);
  const issuingRef = useRef(false);
  useEffect(() => {
    if (!preview) return;
    const check = () => {
      if (Date.now() >= preview.expiresAt) setPreview(undefined);
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [preview]);
  const issue = async () => {
    if (issuingRef.current) return;
    issuingRef.current = true;
    setIssuing(true);
    setError(false);
    setPreview(undefined);
    try {
      setPreview(await issueSharePreview(props, preset));
    } catch {
      setError(true);
    } finally {
      issuingRef.current = false;
      setIssuing(false);
    }
  };
  return (
    <>
      <Copy>閲覧できる期間</Copy>
      <Row>
        {presets.map(({ label }) => (
          <Action
            key={label}
            selected={label === preset}
            disabled={issuing}
            onPress={() => {
              setPreset(label);
              setPreview(undefined);
            }}
          >
            {label}
          </Action>
        ))}
      </Row>
      {props.connection && !preview && (
        <Action disabled={issuing} onPress={() => void issue()}>
          {issuing ? "リンクを発行中…" : "共有リンクを発行"}
        </Action>
      )}
      {!props.connection && <Copy>共有リンクの発行には共有サービスへの接続が必要です。</Copy>}
      {error && (
        <Notice>共有リンクを発行できませんでした。接続と閲覧権限を確認してください。</Notice>
      )}
      {preview && (
        <>
          <Link label="LINEで共有" href={preview.lineUrl} />
          <Link label="署名付きレポートを開く" href={preview.shareUrl} />
          <Link label="サマリーカードを見る" href={preview.summaryCardUrl} />
        </>
      )}
    </>
  );
}
