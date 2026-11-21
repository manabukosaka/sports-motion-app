import { useState } from "react";
import type { DisclosureMode } from "./mode.js";
import { Action, Notice, Page, Row, Title } from "./primitives.js";
import { CaptureScreen, type CaptureScreenProps } from "./screens/CaptureScreen.js";
import { ComparisonScreen, type ComparisonScreenProps } from "./screens/ComparisonScreen.js";
import {
  EditingStudioScreen,
  type EditingStudioScreenProps,
} from "./screens/EditingStudioScreen.js";
import { ShareScreen, type ShareScreenProps } from "./screens/ShareScreen.js";
import {
  TeamDashboardScreen,
  type TeamDashboardScreenProps,
} from "./screens/TeamDashboardScreen.js";

const screens = {
  capture: "撮影",
  editing: "座標修正",
  comparison: "比較",
  team: "チーム",
  share: "共有",
} as const;

const modes = {
  coach: "コーチ",
  researcher: "研究者",
} satisfies Record<DisclosureMode, string>;

export interface SportsMotionAppProps {
  capture: Omit<CaptureScreenProps, "mode">;
  editing: EditingStudioScreenProps;
  comparison: Omit<ComparisonScreenProps, "mode">;
  team: Omit<TeamDashboardScreenProps, "mode">;
  share: ShareScreenProps;
  initialScreen?: keyof typeof screens;
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
  const [screen, setScreen] = useState(initialScreen);
  return (
    <Page>
      <Title>Sports Motion</Title>
      <Row>
        {(Object.keys(modes) as DisclosureMode[]).map((key) => (
          <Action key={key} selected={key === mode} onPress={() => setMode(key)}>
            {modes[key]}
          </Action>
        ))}
      </Row>
      <Row>
        {(Object.keys(screens) as (keyof typeof screens)[]).map((key) => (
          <Action key={key} selected={key === screen} onPress={() => setScreen(key)}>
            {screens[key]}
          </Action>
        ))}
      </Row>
      {notice && <Notice>{notice}</Notice>}
      {screen === "capture" && <CaptureScreen {...capture} mode={mode} />}
      {screen === "editing" && (
        <EditingStudioScreen key={editing.controller.rawPose2d.trial_id} {...editing} />
      )}
      {screen === "comparison" && (
        <ComparisonScreen
          key={comparison.target.analysis_revision_id}
          {...comparison}
          mode={mode}
        />
      )}
      {screen === "team" && <TeamDashboardScreen {...team} mode={mode} />}
      {screen === "share" && <ShareScreen {...share} />}
    </Page>
  );
}
