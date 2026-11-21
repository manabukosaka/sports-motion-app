import type { FrameIndex, Pose3DSequence } from "@sports-motion/contracts";
import { inspectBoneLengthAnomalies, type Pose2DAnomaly } from "@sports-motion/editing";
import { useMemo, useRef, useState } from "react";
import {
  computeLoupeViewport,
  type EditingApiOptions,
  type EditingRecomputeResult,
  type EditingStudioController,
} from "../../editing-studio.js";
import { NonDiagnostic } from "../NonDiagnostic.js";
import {
  Action,
  Copy,
  Grid,
  GuideBanner,
  Loupe,
  Notice,
  Panel,
  Row,
  Scrubber,
  SkeletonCanvas2D,
  Title,
} from "../primitives.js";

import { imageJoints } from "../visual-data.js";

const labels: Record<Pose2DAnomaly | "bone_length", string> = {
  low_confidence: "低信頼度",
  missing_landmark: "欠測",
  acceleration_spike: "加速度スパイク",
  left_right_swap_candidate: "左右反転候補",
  bone_length: "骨長異常",
};

export interface EditingStudioScreenProps {
  controller: EditingStudioController;
  pose3d?: Pose3DSequence;
  api?: EditingApiOptions;
  disclaimer_text_ja?: string;
  onRecomputed?: (result: EditingRecomputeResult) => void;
}

export function EditingStudioScreen({
  controller,
  pose3d,
  api,
  disclaimer_text_ja,
  onRecomputed,
}: EditingStudioScreenProps) {
  const [frameIndex, setFrameIndex] = useState<FrameIndex>();
  const [savedHead, setSavedHead] = useState(() => controller.currentHead);
  const [revisionCount, setRevisionCount] = useState(() => controller.revisions.length);
  const [recomputedPose, setRecomputedPose] = useState<Pose3DSequence>();
  const pose = recomputedPose ?? pose3d;
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const effective = controller.effectivePose2d;
  const boneFrames = useMemo(
    () =>
      new Set(
        pose?.coordinate_frame === "CalibratedWorld3D"
          ? inspectBoneLengthAnomalies(pose).flatMap(({ anomalies }) =>
              anomalies.map(({ frameIndex }) => frameIndex),
            )
          : [],
      ),
    [pose],
  );
  const flagged = controller.inspectionTimeline
    .map((frame) => {
      const flags = [...frame.anomalyFlags];
      return {
        frameIndex: frame.frameIndex,
        hasMissing: frame.missingCount > 0,
        labels: [
          ...flags.map((flag) => labels[flag]),
          ...(boneFrames.has(frame.frameIndex) ? [labels.bone_length] : []),
        ],
      };
    })
    .filter((frame) => frame.labels.length > 0);
  const first = effective.frames[0];
  const index =
    frameIndex ??
    flagged.find(({ hasMissing }) => hasMissing)?.frameIndex ??
    flagged[0]?.frameIndex ??
    first.frame_index;
  const framePosition = Math.max(
    0,
    effective.frames.findIndex((frame) => frame.frame_index === index),
  );
  const frame = effective.frames[framePosition] ?? first;
  const landmark = frame.landmarks.find(({ missing_reason }) => missing_reason !== null);
  const missingPoints = frame.landmarks.flatMap(({ landmark_id, missing_reason }) => {
    if (missing_reason === null) return [];
    const before = effective.frames[framePosition - 1]?.landmarks.find(
      (point) => point.landmark_id === landmark_id,
    );
    const after = effective.frames[framePosition + 1]?.landmarks.find(
      (point) => point.landmark_id === landmark_id,
    );
    const neighbors = [before, after].filter((point) => point?.missing_reason === null);
    if (!neighbors.length) return [];
    return [
      {
        id: landmark_id,
        color: "#fb7185",
        x: neighbors.reduce((sum, point) => sum + point.x, 0) / neighbors.length,
        y: neighbors.reduce((sum, point) => sum + point.y, 0) / neighbors.length,
      },
    ];
  });
  const joints = imageJoints({
    frame,
    width: effective.width_px,
    height: effective.height_px,
    missingPoints,
  });
  const focus =
    joints.find(({ id }) => id === landmark?.landmark_id) ??
    joints.find(({ id }) => id === "right_knee") ??
    joints[0];
  const focusX = focus?.x ?? effective.width_px / 2;
  const focusY = focus?.y ?? effective.height_px / 2;
  const loupe = computeLoupeViewport(focusX, focusY, effective.width_px, effective.height_px);
  const points = joints.map(({ id, x, y, color }) => ({
    id,
    left: (x - loupe.source.x) * loupe.zoom,
    top: (y - loupe.source.y) * loupe.zoom,
    ...(color && { color }),
  }));
  const range = { startFrame: frame.frame_index, endFrame: frame.frame_index };
  const interpolate = (revisionId: string) => {
    if (!landmark) return;
    const isMissing = (position: number) => {
      const neighbor = effective.frames[position];
      return neighbor?.landmarks.some(
        (point) => point.landmark_id === landmark.landmark_id && point.missing_reason !== null,
      );
    };
    let start = framePosition;
    let end = framePosition;
    while (isMissing(start - 1)) start -= 1;
    while (isMissing(end + 1)) end += 1;
    controller.interpolateRange(revisionId, {
      landmarkId: landmark.landmark_id,
      startFrame: effective.frames[start]?.frame_index ?? frame.frame_index,
      endFrame: effective.frames[end]?.frame_index ?? frame.frame_index,
    });
  };
  const edit = (run: (id: string) => void) => {
    if (savingRef.current) return;
    try {
      run(`edit-${Date.now()}-${controller.revisions.length + 1}`);
      setFrameIndex(frame.frame_index);
      setRevisionCount(controller.revisions.length);
      setStatus(
        api
          ? "修正をプレビュー中。保存すると3Dを再計算します。"
          : "サンプル試技の修正をプレビュー中。",
      );
    } catch {
      setStatus("このフレームでは修正できません。対象点と前後のフレームを確認してください。");
    }
  };
  const save = async () => {
    if (!api || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setStatus("保存して3D再計算中…");
    try {
      const result = await controller.commitRevisionAndRecompute(api);
      if (result) {
        setSavedHead(result.current_head);
        setRecomputedPose(result.pose3d);
        onRecomputed?.(result);
      }
      setStatus(
        result ? `3D再計算済み（${result.recompute_ms} ms）` : "保存待ちの修正はありません。",
      );
    } catch {
      setStatus("3D再計算を完了できませんでした。接続を確認して再試行してください。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const frameCount = effective.frames.length;
  return (
    <>
      <Title subtitle="骨格のトラッキングを確認し、見失った関節を修正します。">精度チェック</Title>
      <GuideBanner
        badge={flagged.length ? "STEP 2" : "確認完了"}
        tone={flagged.length ? "warning" : "success"}
      >
        {flagged.length === 0
          ? "全フレームのトラッキング精度を確認できました。下のボタンから比較・指導へ進みましょう。"
          : landmark
            ? "赤いマーカーは関節の欠測です。「区間を自動補間」を押すと、前後のフレームから補えます。"
            : "確認が必要なフレームがあります。下のフレームを選び、骨格の位置を確認してください。"}
      </GuideBanner>
      <Panel title="座標編集">
        <Grid layout="equal">
          <Grid>
            <Copy>
              2D骨格 · フレーム {frame.frame_index} · {revisionCount} 件の操作
            </Copy>
            <SkeletonCanvas2D
              frame={frame}
              width={effective.width_px}
              height={effective.height_px}
              missingPoints={missingPoints}
            />
          </Grid>
          <Grid>
            <Copy>拡大ルーペ · {loupe.zoom}×</Copy>
            <Loupe
              {...loupe.viewport}
              zoom={loupe.zoom}
              points={points}
              frameWidth={effective.width_px}
              frameHeight={effective.height_px}
              focusX={focusX}
              focusY={focusY}
            />
          </Grid>
        </Grid>
        {frameCount > 1 && (
          <Scrubber
            label="編集フレームを移動"
            value={(framePosition / (frameCount - 1)) * 100}
            onChange={(percent) =>
              setFrameIndex(
                effective.frames[Math.round((percent / 100) * (frameCount - 1))]?.frame_index,
              )
            }
          />
        )}
        <Row>
          <Action
            variant={landmark ? "primary" : "secondary"}
            disabled={saving || !landmark}
            onPress={() => edit(interpolate)}
          >
            区間を自動補間
          </Action>
          <Action
            disabled={saving}
            onPress={() => edit((id) => controller.swapLeftRight(id, range))}
          >
            左右反転を修正
          </Action>
          <Action
            variant="ghost"
            disabled={saving || !controller.canUndo}
            onPress={() => edit((id) => controller.undo(id))}
          >
            元に戻す (Undo)
          </Action>
          <Action
            variant="ghost"
            disabled={saving || !controller.canRedo}
            onPress={() => edit((id) => controller.redo(id))}
          >
            やり直す (Redo)
          </Action>
          {api && (
            <Action
              disabled={saving || controller.currentHead === savedHead}
              onPress={() => void save()}
            >
              保存して3D再計算
            </Action>
          )}
        </Row>
        {status && <Notice>{status}</Notice>}
      </Panel>
      <Panel title="確認が必要なフレーム">
        {flagged.length === 0 ? (
          <Copy>確認が必要なフレームはありません。</Copy>
        ) : (
          <Row>
            {flagged.map(({ frameIndex, labels }) => (
              <Action
                key={frameIndex}
                variant="chip"
                selected={frame.frame_index === frameIndex}
                onPress={() => setFrameIndex(frameIndex)}
              >
                {`フレーム ${frameIndex} · ${labels.join("・")}`}
              </Action>
            ))}
          </Row>
        )}
      </Panel>
      <NonDiagnostic {...(disclaimer_text_ja !== undefined && { disclaimer_text_ja })} />
    </>
  );
}
