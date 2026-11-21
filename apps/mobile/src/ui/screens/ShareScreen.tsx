import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WalkingSkeletonAnalysis,
  WalkingSkeletonMobileClient,
} from "../../walking-skeleton.js";
import type { DisclosureMode } from "../mode.js";
import { NonDiagnostic } from "../NonDiagnostic.js";
import {
  Action,
  Copy,
  Footer,
  Grid,
  GuideBanner,
  Link,
  Notice,
  Panel,
  Row,
  ShareCard,
  Title,
  ToggleSwitch,
} from "../primitives.js";

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
  mode?: DisclosureMode;
  onToggleConsent?: (next: boolean) => void;
  onBack?: () => void;
  title?: string;
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

export function shareTargetKey({ analysis, connection }: ShareScreenProps) {
  return JSON.stringify([
    connection?.teamId,
    connection?.shareWebBaseUrl,
    analysis.analysis_revision_id,
    analysis.evidence_snapshot_id,
    analysis.evidence_registry_version,
  ]);
}

export function ShareScreen(props: ShareScreenProps) {
  return <ShareWorkflow key={shareTargetKey(props)} {...props} />;
}

function ShareWorkflow(props: ShareScreenProps) {
  const {
    analysis,
    shareConsent,
    mode,
    connection,
    onToggleConsent,
    onBack,
    title = "試技の3Dレポート",
  } = props;
  const [preset, setPreset] = useState<(typeof presets)[number]["label"]>("24時間");
  const [issued, setPreview] = useState<Awaited<ReturnType<typeof issueSharePreview>>>();
  const preview = shareConsent === true ? issued : undefined;
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(false);
  const issuingRef = useRef(false);
  const consentVersion = useRef(0);
  const clearIssue = useCallback(() => {
    consentVersion.current += 1;
    setPreview(undefined);
    setError(false);
  }, []);
  useEffect(() => {
    if (shareConsent !== true) clearIssue();
  }, [shareConsent, clearIssue]);
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
    if (shareConsent !== true || !connection || issuingRef.current) return;
    issuingRef.current = true;
    const version = consentVersion.current;
    setIssuing(true);
    setError(false);
    try {
      const result = await issueSharePreview(props, preset);
      if (version === consentVersion.current) setPreview(result);
    } catch {
      if (version === consentVersion.current) setError(true);
    } finally {
      issuingRef.current = false;
      setIssuing(false);
    }
  };
  return (
    <>
      <Title subtitle="3Dレポートの閲覧リンクを発行し、選手にLINEで届けます。">
        選手へのLINE共有
      </Title>
      <GuideBanner badge={preview ? "発行完了" : "STEP 4"} tone={preview ? "success" : "default"}>
        {shareConsent !== true
          ? "① 選手の同意を確認し、「選手の共有同意を確認しました」スイッチをONにしてください。"
          : preview
            ? "✓ 発行完了。レポートを開いて確認するか、LINEで共有できます。"
            : connection
              ? "② 閲覧期間を選び、「共有リンクを発行」を押すと、選手に送れる3DレポートのURLが発行されます。"
              : "共有リンクを発行するには、共有サービスへの接続が必要です。"}
      </GuideBanner>
      <Grid layout="equal">
        <Panel title="LINE共有プレビュー">
          <ShareCard title={title} url={preview?.summaryCardUrl} />
          {preview && (
            <Row>
              <Link label="署名付きレポートを開く" href={preview.shareUrl} />
              <Link label="サマリーカードを見る" href={preview.summaryCardUrl} />
            </Row>
          )}
        </Panel>
        <Panel title="共有する前に">
          <ToggleSwitch
            label="選手の共有同意を確認しました"
            checked={shareConsent === true}
            {...(onToggleConsent && {
              onToggle: (next: boolean) => {
                if (!next) clearIssue();
                onToggleConsent(next);
              },
            })}
          />
          {shareConsent !== true && <Copy>選手の共有同意が必要です。</Copy>}
          <Copy>リンクの閲覧期間</Copy>
          <Row>
            {presets.map(({ label }) => (
              <Action
                key={label}
                variant="chip"
                selected={label === preset}
                disabled={issuing}
                onPress={() => {
                  setPreset(label);
                  setPreview(undefined);
                  setError(false);
                }}
              >
                {label}
              </Action>
            ))}
          </Row>
          {preview && <Copy>閲覧期限：{new Date(preview.expiresAt).toLocaleString("ja-JP")}</Copy>}
          {shareConsent && error && (
            <Notice>共有リンクを発行できませんでした。接続と閲覧権限を確認してください。</Notice>
          )}
        </Panel>
      </Grid>
      {mode === "researcher" && (
        <Panel title="共有レポートの解析情報">
          <Copy>analysis_revision_id {analysis.analysis_revision_id}</Copy>
          <Copy>evidence_snapshot_id {analysis.evidence_snapshot_id}</Copy>
          <Copy>evidence_registry_version {analysis.evidence_registry_version}</Copy>
        </Panel>
      )}
      <Footer {...(onBack && { onBack })}>
        {preview ? (
          <Link label="LINEで共有" href={preview.lineUrl} />
        ) : (
          <Action
            variant="primary"
            disabled={shareConsent !== true || !connection || issuing}
            onPress={() => void issue()}
          >
            {issuing ? "リンクを発行中…" : "共有リンクを発行"}
          </Action>
        )}
      </Footer>
      <NonDiagnostic disclaimer_text_ja={analysis.disclaimer_text_ja} />
    </>
  );
}
