import type { TwoTrialComparison } from "@sports-motion/coaching";
import {
  type Pose2DSequence,
  type Pose3DSequence,
  skeletonGeometry,
} from "@sports-motion/contracts";

export interface Skeleton2DProps {
  frame: Pose2DSequence["frames"][number];
  width: number;
  height: number;
  missingPoints?: readonly JointPoint[];
}

export interface Skeleton3DProps {
  pose: Pose3DSequence;
  frame: number;
  caption?: string;
}

export interface WaveformProps {
  comparison: TwoTrialComparison;
  percent: number;
  onSeek: (percent: number) => void;
}

export interface TrendProps {
  points: readonly { capturedAt: string; value: number }[];
  unit: string;
}

export interface Point {
  x: number;
  y: number;
}
export interface JointPoint extends Point {
  id: string;
  color?: string;
}

const segments = [
  ["nose", "left_shoulder"],
  ["nose", "right_shoulder"],
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "pelvis"],
  ["pelvis", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
  ["right_ankle", "right_foot_index"],
] as const;

const drawnJoints = new Set<string>(segments.flat());

export const court = { width: 400, height: 252 };
export const graph = { width: 400, height: 252, left: 42, right: 378, top: 28, bottom: 208 };
export const cameraPresets = [
  { label: "斜め", yaw: -0.64, pitch: 0.13 },
  { label: "正面", yaw: 0, pitch: 0 },
  { label: "側面", yaw: -Math.PI / 2, pitch: 0 },
] as const;

export function skeletonSegments(joints: readonly JointPoint[]) {
  const byId = new Map(joints.map((joint) => [joint.id, joint]));
  return segments.flatMap(([from, to]) => {
    const a = byId.get(from),
      b = byId.get(to);
    return a && b ? [{ id: `${from}-${to}`, a, b, color: a.color ?? b.color ?? "#5eead4" }] : [];
  });
}

export function imageJoints({ frame, missingPoints = [] }: Skeleton2DProps) {
  return [
    ...frame.landmarks.flatMap((point) =>
      point.missing_reason === null && drawnJoints.has(point.landmark_id)
        ? [
            {
              id: point.landmark_id,
              x: point.x,
              y: point.y,
              ...(point.confidence !== null && point.confidence < 0.5 && { color: "#fbbf24" }),
            },
          ]
        : [],
    ),
    ...missingPoints,
  ];
}

export function poseBounds(pose: Pose3DSequence) {
  const points = pose.frames.flatMap(({ landmarks }) =>
    landmarks.filter((point) => point.missing_reason === null),
  );
  if (!points.length) return { x: 0, y: 0, z: 0, radius: 1 };
  const center = (axis: "x" | "y" | "z") => {
    const values = points.map((point) => point[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  const x = center("x"),
    y = center("y"),
    z = center("z");
  const radius = Math.max(0.01, ...points.map((p) => Math.hypot(p.x - x, p.y - y, p.z - z)));
  return { x, y, z, radius };
}

export function projectPose(
  pose: Pose3DSequence,
  frame: number,
  bounds: ReturnType<typeof poseBounds>,
  yaw: number,
  pitch: number,
) {
  const current = pose.frames.find(({ frame_index }) => frame_index === frame) ?? pose.frames[0];
  const scale = 99 / bounds.radius;
  const sinY = Math.sin(yaw),
    cosY = Math.cos(yaw);
  const sinP = Math.sin(pitch),
    cosP = Math.cos(pitch);
  const joints =
    (current &&
      skeletonGeometry(current).joints.flatMap(([id, [xMeters, yMeters, zMeters]]) => {
        if (!drawnJoints.has(id)) return [];
        const x = xMeters - bounds.x,
          y = yMeters - bounds.y,
          z = zMeters - bounds.z;
        return [
          {
            id,
            x: court.width / 2 + (x * cosY - z * sinY) * scale,
            y: court.height / 2 - (y * cosP - (x * sinY + z * cosY) * sinP) * scale,
          },
        ];
      })) ??
    [];
  return { frame: current?.frame_index, joints };
}

function valueAxis(values: readonly number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = Math.max(1, Math.ceil((max - min) / 4));
  const lower = Math.floor(min / step) * step;
  const upper = Math.max(lower + step, Math.ceil(max / step) * step);
  return {
    labels: [lower, (lower + upper) / 2, upper],
    y: (value: number) =>
      graph.bottom - ((value - lower) / (upper - lower)) * (graph.bottom - graph.top),
  };
}

export function graphX(percent: number) {
  return graph.left + (percent / 100) * (graph.right - graph.left);
}

export function graphPercent(x: number) {
  return Math.max(0, Math.min(100, ((x - graph.left) / (graph.right - graph.left)) * 100));
}

export function waveformGeometry({ series }: TwoTrialComparison) {
  const axis = valueAxis(
    series.flatMap((point) =>
      [
        point.baselineValue,
        point.targetValue,
        point.referenceLower1Sd,
        point.referenceUpper1Sd,
      ].filter((value) => value !== undefined),
    ),
  );
  const baseline: Point[] = [];
  const target: Point[] = [];
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const point of series) {
    const x = graphX(point.percent);
    baseline.push({ x, y: axis.y(point.baselineValue) });
    target.push({ x, y: axis.y(point.targetValue) });
    if (point.referenceLower1Sd !== undefined && point.referenceUpper1Sd !== undefined) {
      lower.push({ x, y: axis.y(point.referenceLower1Sd) });
      upper.push({ x, y: axis.y(point.referenceUpper1Sd) });
    }
  }
  return { axis, baseline, target, lower, upper };
}

export function trendGeometry(points: TrendProps["points"]) {
  const axis = valueAxis(points.map(({ value }) => value));
  const first = Date.parse(points[0]?.capturedAt ?? "");
  const duration = Date.parse(points.at(-1)?.capturedAt ?? "") - first;
  return {
    axis,
    curve: points.map(({ capturedAt, value }, index) => ({
      x: graphX(
        duration > 0
          ? ((Date.parse(capturedAt) - first) / duration) * 100
          : points.length > 1
            ? (index / (points.length - 1)) * 100
            : 50,
      ),
      y: axis.y(value),
    })),
  };
}
