import { useState } from "react";
import type { DisclosureMode } from "./mode.js";
import { NonDiagnostic } from "./NonDiagnostic.js";
import { Action, Footer, Header, Notice, Page, Stepper, ViewSlot } from "./primitives.js";
import { CaptureScreen, type CaptureScreenProps } from "./screens/CaptureScreen.js";
import { ComparisonScreen, type ComparisonScreenProps } from "./screens/ComparisonScreen.js";
import {
  EditingStudioScreen,
  type EditingStudioScreenProps,
} from "./screens/EditingStudioScreen.js";
import { ShareScreen, type ShareScreenProps, shareTargetKey } from "./screens/ShareScreen.js";
import {
  TeamDashboardScreen,
  type TeamDashboardScreenProps,
} from "./screens/TeamDashboardScreen.js";

const steps = ["capture", "editing", "comparison", "share"] as const;
const labels = ["動画を選ぶ", "精度チェック", "比較・指導", "選手へ共有"] as const;
type WorkflowStep = (typeof steps)[number];

export interface SportsMotionAppProps {
  capture: Omit<CaptureScreenProps, "mode">;
  editing: EditingStudioScreenProps;
  comparison: Omit<ComparisonScreenProps, "mode">;
  team: Omit<TeamDashboardScreenProps, "mode">;
  share: ShareScreenProps;
  initialScreen?: WorkflowStep | "team";
  initialMode?: DisclosureMode;
  notice?: string;
}

export function SportsMotionApp({
  capture,
  editing,
  comparison,
  team,
  share,
  initialMode = "coach",
  initialScreen = "capture",
  notice,
}: SportsMotionAppProps) {
  const [mode, setMode] = useState<DisclosureMode>(initialMode);
  const [step, setStep] = useState<WorkflowStep>(
    initialScreen === "team" ? "capture" : initialScreen,
  );
  const [archive, setArchive] = useState(initialScreen === "team");
  const [visited, setVisited] = useState(() => new Set([steps.indexOf(step)]));
  const [consent, setConsent] = useState<{ identity: string; value: boolean }>();
  const [savingCapture, setSavingCapture] = useState(false);
  const [captureError, setCaptureError] = useState(false);
  const captureBusy = savingCapture || capture.loading === true;
  const active = steps.indexOf(step);
  const shareIdentity = shareTargetKey(share);
  const shareConsent = consent?.identity === shareIdentity ? consent.value : share.shareConsent;
  const go = (next: WorkflowStep) => {
    setStep(next);
    setVisited((previous) => new Set([...previous, steps.indexOf(next)]));
  };
  const start = async () => {
    if (captureBusy) return;
    setSavingCapture(true);
    try {
      setCaptureError(false);
      await capture.onSaveCapture?.();
    } catch {
      setCaptureError(true);
    } finally {
      setSavingCapture(false);
    }
    go("editing");
  };
  const choose = (selection: CaptureScreenProps["selection"]) => {
    if (
      selection.movement !== capture.selection.movement ||
      selection.coordinateFrame !== capture.selection.coordinateFrame
    ) {
      setVisited(new Set([0]));
    }
    capture.onSelect(selection);
  };
  return (
    <Page focusKey={archive ? "team" : step}>
      <Header>
        <Action variant="ghost" onPress={() => setArchive(!archive)}>
          {archive ? "解析に戻る" : "チーム管理"}
        </Action>
        <Action
          variant="ghost"
          selected={mode === "researcher"}
          onPress={() => setMode(mode === "coach" ? "researcher" : "coach")}
        >
          {mode === "researcher" ? "詳細解析 ON" : "詳細解析 OFF"}
        </Action>
      </Header>
      {!archive && (
        <Stepper
          steps={labels}
          active={active}
          visited={visited}
          onSelect={(index) => {
            const next = steps[index];
            if (next) go(next);
          }}
        />
      )}
      {notice && <Notice>{notice}</Notice>}
      {captureError && (
        <Notice>端末に試技を保存できませんでした。サンプルで精度チェックを続けられます。</Notice>
      )}
      <ViewSlot hidden={archive || step !== "capture"}>
        <CaptureScreen
          {...capture}
          mode={mode}
          onSelect={choose}
          onSample={captureBusy ? undefined : () => void start()}
        />
        <Footer>
          <Action variant="primary" disabled={captureBusy} onPress={() => void start()}>
            {savingCapture ? "端末に保存中…" : "解析を開始して精度チェックへ →"}
          </Action>
        </Footer>
        {!archive && step === "capture" && (
          <NonDiagnostic disclaimer_text_ja={share.analysis.disclaimer_text_ja} />
        )}
      </ViewSlot>
      {visited.has(1) && (
        <ViewSlot hidden={archive || step !== "editing"}>
          <EditingStudioScreen key={editing.controller.rawPose2d.trial_id} {...editing} />
          <Footer onBack={() => go("capture")}>
            <Action variant="primary" onPress={() => go("comparison")}>
              次へ：試技の比較・指導へ →
            </Action>
          </Footer>
        </ViewSlot>
      )}
      {archive ? (
        <TeamDashboardScreen {...team} mode={mode} />
      ) : (
        <>
          {step === "comparison" && (
            <>
              <ComparisonScreen
                key={comparison.target.analysis_revision_id}
                {...comparison}
                mode={mode}
              />
              <Footer onBack={() => go("editing")}>
                <Action variant="primary" onPress={() => go("share")}>
                  次へ：選手へのLINE共有へ →
                </Action>
              </Footer>
            </>
          )}
          {step === "share" && (
            <ShareScreen
              {...share}
              shareConsent={shareConsent}
              mode={mode}
              onBack={() => go("comparison")}
              onToggleConsent={(value) => {
                setConsent({ identity: shareIdentity, value });
                share.onToggleConsent?.(value);
              }}
            />
          )}
        </>
      )}
    </Page>
  );
}
