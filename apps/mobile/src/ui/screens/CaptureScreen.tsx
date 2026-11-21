import type { LocalCapture } from "../../walking-skeleton.js";
import type { DisclosureMode } from "../mode.js";
import {
  ChoiceCard,
  Copy,
  Grid,
  GuideBanner,
  Notice,
  Panel,
  Title,
  VideoDropzone,
} from "../primitives.js";

export type CaptureMovement = LocalCapture["movement"];
export type CaptureMode = "HipRelative3D" | "CalibratedWorld3D";
export type CaptureQueueStatus = "LocalCaptured" | "QueuedOffline" | "Uploaded";

export interface CaptureSelection {
  movement: CaptureMovement;
  coordinateFrame: CaptureMode;
}

export interface CaptureQueueItem extends CaptureSelection {
  capture_id: string;
  status: CaptureQueueStatus;
}

export interface CaptureScreenProps {
  mode: DisclosureMode;
  selection: CaptureSelection;
  onSelect: (selection: CaptureSelection) => void;
  queue?: readonly CaptureQueueItem[];
  onSaveCapture?: () => void | Promise<void>;
  loading?: boolean;
  onSample?: (() => void) | undefined;
  live?: boolean;
}

const movements = {
  baseball_pitching: { label: "野球投球", description: "リリース前後の腕の動き", icon: "↗" },
  running: { label: "ランニング", description: "接地から次の接地まで", icon: "⇢" },
  jump_landing: { label: "ジャンプ・着地", description: "踏み切りと着地（CMJ/DVJ）", icon: "↑" },
} satisfies Record<CaptureMovement, { label: string; description: string; icon: string }>;

const captureModes = {
  HipRelative3D: { label: "かんたん1カメラ", description: "校正なしで参考角度を確認", icon: "1" },
  CalibratedWorld3D: {
    label: "高精度2カメラ校正",
    description: "校正済みの2視点で実寸3Dを再構成",
    icon: "2",
  },
} satisfies Record<CaptureMode, { label: string; description: string; icon: string }>;

const statuses = {
  LocalCaptured: "端末に保存済み",
  QueuedOffline: "オフライン・送信待ち",
  Uploaded: "送信済み",
} satisfies Record<CaptureQueueStatus, string>;

export function CaptureScreen({
  mode,
  selection,
  onSelect,
  queue = [],
  onSample,
  live,
}: CaptureScreenProps) {
  return (
    <>
      <Title subtitle="競技に合わせて、見たい動作と撮影方法を選びます。">解析する動画を選ぶ</Title>
      <GuideBanner badge="STEP 1">
        競技を選び、動画をプレビューするか、サンプル試技で精度チェックへ進みましょう。
      </GuideBanner>
      <Grid layout="split">
        <Grid>
          <Panel title="競技・動作">
            <Grid layout="choices">
              {(Object.keys(movements) as CaptureMovement[]).map((movement) => (
                <ChoiceCard
                  key={movement}
                  {...movements[movement]}
                  selected={selection.movement === movement}
                  onPress={() => onSelect({ ...selection, movement })}
                />
              ))}
            </Grid>
          </Panel>
          <Panel title="動画プレビュー">
            <VideoDropzone {...(onSample && { onSample })} />
            <Copy>
              取り込んだ動画は端末内でプレビューできます。解析画面では選んだ競技のデモ試技を使います。
            </Copy>
          </Panel>
        </Grid>
        <Grid>
          <Panel title="撮影方法">
            <Grid>
              {(Object.keys(captureModes) as CaptureMode[]).map((coordinateFrame) => (
                <ChoiceCard
                  key={coordinateFrame}
                  {...captureModes[coordinateFrame]}
                  selected={selection.coordinateFrame === coordinateFrame}
                  onPress={() => onSelect({ ...selection, coordinateFrame })}
                />
              ))}
            </Grid>
            {selection.coordinateFrame === "CalibratedWorld3D" && (
              <Copy>2台を固定し、DLTポールまたはチェッカーボードで校正します。</Copy>
            )}
            {selection.coordinateFrame === "CalibratedWorld3D" && !live && (
              <Copy>この競技のデモ試技は参考角度で表示します。</Copy>
            )}
            {mode === "researcher" && <Copy>{selection.coordinateFrame}</Copy>}
          </Panel>
          <Panel title="撮影キュー">
            {queue.length === 0 && <Copy>端末に保存した試技がここに表示されます。</Copy>}
            {queue.map(({ capture_id, status, movement, coordinateFrame }) => (
              <Copy key={capture_id}>
                {movements[movement].label} · {captureModes[coordinateFrame].label} ·{" "}
                {statuses[status]}
                {status === "QueuedOffline" || mode === "researcher"
                  ? ` (${status}) · ${capture_id}`
                  : ""}
              </Copy>
            ))}
            {live && (
              <Notice tone="success">
                サンプル接続済み · Pythonで再構成した合成ランニング試技
              </Notice>
            )}
          </Panel>
        </Grid>
      </Grid>
    </>
  );
}
