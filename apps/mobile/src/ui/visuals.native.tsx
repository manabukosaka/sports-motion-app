import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Action, Copy, Row } from "./primitives.native.js";
import { colors } from "./theme.js";
import {
  cameraPresets,
  court,
  graph,
  graphPercent,
  graphX,
  imageJoints,
  type JointPoint,
  type Point,
  poseBounds,
  projectPose,
  type Skeleton2DProps,
  type Skeleton3DProps,
  skeletonSegments,
  type TrendProps,
  trendGeometry,
  type WaveformProps,
  waveformGeometry,
} from "./visual-data.js";

function Line({
  a,
  b,
  color,
  thickness = 2,
}: {
  a: Point;
  b: Point;
  color: string;
  thickness?: number;
}) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return (
    <View
      style={{
        position: "absolute",
        width: length,
        height: thickness,
        backgroundColor: color,
        left: (a.x + b.x - length) / 2,
        top: (a.y + b.y - thickness) / 2,
        transform: [{ rotateZ: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

function Dot({ point, color, size = 6 }: { point: Point; color: string; size?: number }) {
  return (
    <View
      style={{
        position: "absolute",
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

function Skeleton({
  joints,
  width,
  height,
  label,
  frameLabel,
}: {
  joints: readonly JointPoint[];
  width: number;
  height: number;
  label: string;
  frameLabel?: string;
}) {
  const [layout, setLayout] = useState(0);
  const scale = layout / width;
  const scaled = joints.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale }));
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onLayout={({ nativeEvent }) => setLayout(nativeEvent.layout.width)}
      style={{
        backgroundColor: colors.dark,
        aspectRatio: width / height,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          position: "absolute",
          top: "10%",
          bottom: "10%",
          left: "8%",
          right: "8%",
          borderWidth: 1,
          borderColor: "#385367",
          borderRadius: 6,
        }}
      />
      {frameLabel && (
        <Text style={{ position: "absolute", top: 12, left: 12, color: "#99f6e4", fontSize: 10 }}>
          {frameLabel}
        </Text>
      )}
      {skeletonSegments(scaled).map(({ id, a, b, color }) => (
        <Line key={id} a={a} b={b} color={color} thickness={3} />
      ))}
      {scaled.map((point) => (
        <Dot
          key={point.id}
          point={point}
          color={point.color ?? "#ccfbf1"}
          size={point.color ? 10 : 6}
        />
      ))}
    </View>
  );
}

export function SkeletonCanvas2D(props: Skeleton2DProps) {
  return (
    <Skeleton
      joints={imageJoints(props)}
      width={props.width}
      height={props.height}
      label={`2D骨格 · フレーム ${props.frame.frame_index}`}
    />
  );
}

export function SkeletonPreview3D({ pose, frame, caption }: Skeleton3DProps) {
  const [preset, setPreset] = useState(0);
  const camera = cameraPresets[preset] ?? cameraPresets[0];
  const bounds = useMemo(() => poseBounds(pose), [pose]);
  const projected = projectPose(pose, frame, bounds, camera.yaw, camera.pitch);
  return (
    <>
      <Skeleton
        joints={projected.joints}
        {...court}
        frameLabel={pose.coordinate_frame === "CalibratedWorld3D" ? "WORLD 3D" : "HIP RELATIVE 3D"}
        label={`3D骨格 · フレーム ${projected.frame ?? "—"}`}
      />
      <Row>
        {cameraPresets.map(({ label }, index) => (
          <Action
            key={label}
            variant="chip"
            selected={index === preset}
            onPress={() => setPreset(index)}
          >
            {label}
          </Action>
        ))}
        {caption && <Copy>{caption}</Copy>}
      </Row>
    </>
  );
}

function Curve({
  points,
  color,
  dashed = false,
}: {
  points: readonly Point[];
  color: string;
  dashed?: boolean;
}) {
  const cadence = Math.max(1, Math.round((points.length - 1) / 48));
  return points.slice(1).map((b, index) => {
    if (dashed && Math.floor(index / cadence) % 5 >= 3) return null;
    const a = points[index];
    return a && <Line key={`${a.x}-${a.y}-${index}`} a={a} b={b} color={color} />;
  });
}

export function WaveformChart({ comparison, percent, onSeek }: WaveformProps) {
  const data = useMemo(() => waveformGeometry(comparison), [comparison]);
  const [width, setWidth] = useState(0);
  const scale = width / graph.width;
  const scaled = (points: readonly Point[]) =>
    points.map(({ x, y }) => ({ x: x * scale, y: y * scale }));
  const x = graphX(percent) * scale;
  return (
    <>
      <Pressable
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="波形の再生位置"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) =>
          onSeek(
            Math.min(100, Math.max(0, percent + (nativeEvent.actionName === "increment" ? 5 : -5))),
          )
        }
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onPress={({ nativeEvent }) => {
          if (scale) onSeek(graphPercent(nativeEvent.locationX / scale));
        }}
        style={{
          aspectRatio: graph.width / graph.height,
          borderRadius: 12,
          backgroundColor: colors.canvas,
        }}
      >
        <View pointerEvents="none">
          {data.axis.labels.map((value) => (
            <Text
              key={value}
              style={{
                position: "absolute",
                color: colors.secondary,
                fontSize: 10,
                top: data.axis.y(value) * scale - 7,
                left: 3,
              }}
            >
              {value}
            </Text>
          ))}
          {data.upper.slice(1).map((right, index) => {
            const left = data.upper[index];
            const low = data.lower[index];
            const nextLow = data.lower[index + 1];
            if (!left || !low || !nextLow) return null;
            return (
              <View
                key={left.x}
                style={{
                  position: "absolute",
                  backgroundColor: "#dbeafe",
                  left: left.x * scale,
                  top: ((left.y + right.y) * scale) / 2,
                  width: (right.x - left.x) * scale,
                  height: ((low.y + nextLow.y - left.y - right.y) * scale) / 2,
                }}
              />
            );
          })}
          <Curve points={scaled(data.baseline)} color={colors.muted} dashed />
          <Curve points={scaled(data.target)} color={colors.accent} />
          <Line
            a={{ x, y: graph.top * scale }}
            b={{ x, y: graph.bottom * scale }}
            color={colors.cobalt}
          />
          {[0, 50, 100].map((tick) => (
            <Text
              key={tick}
              style={{
                position: "absolute",
                fontSize: 10,
                color: colors.secondary,
                left: graphX(tick) * scale - 11,
                top: 225 * scale,
              }}
            >
              {tick}%
            </Text>
          ))}
        </View>
      </Pressable>
      <Copy>
        前回 / 今回 · {comparison.unit}
        {data.lower.length
          ? ` · ±1SD帯${comparison.referenceBandSummary?.source.kind === "synthetic" ? "（合成データ）" : ""}`
          : ""}
      </Copy>
    </>
  );
}

export function TrendChart({ points, unit }: TrendProps) {
  const [width, setWidth] = useState(0);
  if (!points.length) return null;
  const { curve } = trendGeometry(points);
  const scale = width / graph.width;
  const scaled = curve.map(({ x, y }) => ({ x: x * scale, y: y * scale }));
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`試技の計測値の推移 (${unit})`}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      style={{
        aspectRatio: graph.width / graph.height,
        borderRadius: 12,
        backgroundColor: colors.canvas,
      }}
    >
      <Curve points={scaled} color={colors.accent} />
      {scaled.map((point, index) => {
        const trial = points[index];
        if (!trial) return null;
        return (
          <View key={`${trial.capturedAt}-${index}`} style={{ position: "absolute" }}>
            <Dot point={point} color={colors.accent} size={8} />
            <Text
              style={{
                position: "absolute",
                width: 45,
                left: point.x - 15,
                top: point.y - 23,
                fontSize: 11,
              }}
            >
              {trial.value.toFixed(1)}
            </Text>
            <Text
              style={{
                position: "absolute",
                width: 45,
                left: point.x - 15,
                top: 224 * scale,
                fontSize: 10,
              }}
            >
              {trial.capturedAt.slice(5, 10).replace("-", "/")}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
