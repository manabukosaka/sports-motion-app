import type { LocalCapture } from "../../walking-skeleton.js";
import type { DisclosureMode } from "../mode.js";
import { Action, Copy, Notice, Panel, Row } from "../primitives.js";

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
  onSaveCapture?: () => void;
}

const movements = {
  baseball_pitching: "野球投球",
  running: "ランニング",
  jump_landing: "ジャンプ・着地 (CMJ/DVJ)",
} satisfies Record<CaptureMovement, string>;

const captureModes = {
  HipRelative3D: "かんたん1カメラ（参考角度）",
  CalibratedWorld3D: "高精度2カメラ校正（実寸3D）",
} satisfies Record<CaptureMode, string>;

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
  onSaveCapture,
}: CaptureScreenProps) {
  return (
    <>
      <Panel title="撮影する動作">
        <Row>
          {(Object.keys(movements) as CaptureMovement[]).map((movement) => (
            <Action
              key={movement}
              selected={selection.movement === movement}
              onPress={() => onSelect({ ...selection, movement })}
            >
              {movements[movement]}
            </Action>
          ))}
        </Row>
      </Panel>
      <Panel title="撮影方法">
        <Row>
          {(Object.keys(captureModes) as CaptureMode[]).map((coordinateFrame) => (
            <Action
              key={coordinateFrame}
              selected={selection.coordinateFrame === coordinateFrame}
              onPress={() => onSelect({ ...selection, coordinateFrame })}
            >
              {captureModes[coordinateFrame]}
            </Action>
          ))}
        </Row>
        {selection.coordinateFrame === "CalibratedWorld3D" && (
          <Copy>2台を固定し、DLTポールまたはチェッカーボードで校正します。</Copy>
        )}
        {mode === "researcher" && <Copy>{selection.coordinateFrame}</Copy>}
        {onSaveCapture && <Action onPress={onSaveCapture}>端末に保存</Action>}
      </Panel>
      <Panel title="撮影キュー">
        {queue.length === 0 && <Copy>端末に保存された試技はありません。</Copy>}
        {queue.map(({ capture_id, status, movement, coordinateFrame }) => (
          <Notice key={capture_id}>
            {`${movements[movement]} · ${captureModes[coordinateFrame]} · ${statuses[status]} (${status}) · ${capture_id}`}
          </Notice>
        ))}
      </Panel>
    </>
  );
}
