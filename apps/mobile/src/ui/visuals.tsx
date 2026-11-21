import { type PointerEvent, useMemo, useRef, useState } from "react";
import { Action, Copy, Row } from "./primitives.js";
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

const polyline = (points: readonly Point[]) => points.map(({ x, y }) => `${x},${y}`).join(" ");

function CourtMarks({ width, height }: { width: number; height: number }) {
  return (
    <g fill="none" stroke="#385367" strokeWidth="0.7">
      {[0.2, 0.35, 0.5, 0.65, 0.8].map((fraction) => (
        <line
          key={fraction}
          x1={width * fraction}
          x2={width * fraction}
          y1={height * 0.12}
          y2={height * 0.89}
          opacity=".5"
        />
      ))}
      {[0.24, 0.4, 0.56, 0.72, 0.88].map((fraction) => (
        <line
          key={fraction}
          x1={width * 0.13}
          x2={width * 0.87}
          y1={height * fraction}
          y2={height * fraction}
          opacity=".5"
        />
      ))}
      <rect x={width * 0.08} y={height * 0.09} width={width * 0.84} height={height * 0.82} rx="4" />
      <path
        d={`M${width * 0.08} ${height * 0.5}h${width * 0.84} M${width * 0.5} ${height * 0.09}v${height * 0.82}`}
        strokeDasharray="3 5"
      />
      <ellipse cx={width / 2} cy={height * 0.88} rx={width * 0.2} ry={height * 0.035} />
    </g>
  );
}

function Bones({ joints }: { joints: readonly JointPoint[] }) {
  return (
    <>
      {skeletonSegments(joints).map(({ id, a, b, color }) => (
        <line
          key={id}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity={color === "#fb7185" ? 0.54 : 0.88}
          strokeDasharray={color === "#fb7185" ? "4 5" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {joints.map(({ id, x, y, color }) => (
        <g key={id} data-joint={id} data-anomaly={color ? "true" : undefined}>
          {color && <circle cx={x} cy={y} r="8" fill="none" stroke={color} strokeWidth="1.5" />}
          <circle
            cx={x}
            cy={y}
            r="3.4"
            fill={color ?? "#ccfbf1"}
            stroke="#0f172a"
            strokeWidth="0.85"
          />
        </g>
      ))}
    </>
  );
}

const courtStyle = {
  width: "100%",
  height: "auto",
  display: "block",
  borderRadius: 12,
  background: "radial-gradient(ellipse at 50% 58%, #1d3543 0%, #0f172a 76%)",
} as const;

export function SkeletonCanvas2D(props: Skeleton2DProps) {
  const { width, height, frame } = props;
  return (
    <svg
      role="img"
      aria-label={`2D骨格 · フレーム ${frame.frame_index}`}
      data-skeleton="2d"
      viewBox={`0 0 ${width} ${height}`}
      style={courtStyle}
    >
      <CourtMarks width={width} height={height} />
      <Bones joints={imageJoints(props)} />
    </svg>
  );
}

export function SkeletonPreview3D({ pose, frame, caption }: Skeleton3DProps) {
  const [camera, setCamera] = useState<{ yaw: number; pitch: number }>(cameraPresets[0]);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const bounds = useMemo(() => poseBounds(pose), [pose]);
  const projected = projectPose(pose, frame, bounds, camera.yaw, camera.pitch);
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current) return;
    const { x, y } = drag.current;
    drag.current = { x: event.clientX, y: event.clientY };
    setCamera(({ yaw, pitch }) => ({
      yaw: yaw + (event.clientX - x) * 0.013,
      pitch: Math.max(-1.35, Math.min(1.35, pitch + (event.clientY - y) * 0.012)),
    }));
  }
  return (
    <>
      <svg
        role="img"
        aria-label={`3D骨格 · フレーム ${projected.frame ?? "—"}`}
        viewBox={`0 0 ${court.width} ${court.height}`}
        data-skeleton="3d"
        data-frame={projected.frame}
        style={{ ...courtStyle, cursor: "grab", touchAction: "none" }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={move}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      >
        <CourtMarks {...court} />
        <text x="16" y="39" fill="#8cf7e4" fontSize="10" fontFamily="monospace">
          {pose.coordinate_frame === "CalibratedWorld3D" ? "WORLD 3D" : "HIP RELATIVE 3D"}
        </text>
        <path
          d="M27 220V199 M27 220L44 226 M27 220L14 229"
          stroke="#5eead4"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <Bones joints={projected.joints} />
      </svg>
      <Row>
        {cameraPresets.map((preset) => (
          <Action
            key={preset.label}
            variant="chip"
            selected={camera.yaw === preset.yaw && camera.pitch === preset.pitch}
            onPress={() => setCamera(preset)}
          >
            {preset.label}
          </Action>
        ))}
        {caption && <Copy>{caption}</Copy>}
      </Row>
    </>
  );
}

const chartStyle = {
  width: "100%",
  height: "auto",
  display: "block",
  background: "#f8fafc",
  borderRadius: 12,
} as const;

function ValueGrid({
  unit,
  axis,
}: {
  unit: string;
  axis: ReturnType<typeof waveformGeometry>["axis"];
}) {
  return (
    <g fontSize="11" fill={colors.secondary} fontFamily="system-ui, sans-serif">
      <text x="14" y="17">
        {unit === "deg" ? "角度 (°)" : unit}
      </text>
      {axis.labels.map((label) => (
        <g key={label}>
          <line
            x1={graph.left}
            x2={graph.right}
            y1={axis.y(label)}
            y2={axis.y(label)}
            stroke="#dbe4ed"
          />
          <text x={graph.left - 8} y={axis.y(label) + 4} textAnchor="end">
            {label}
          </text>
        </g>
      ))}
    </g>
  );
}

export function WaveformChart({ comparison, percent, onSeek }: WaveformProps) {
  const data = useMemo(() => waveformGeometry(comparison), [comparison]);
  const playhead = graphX(percent);
  const svg = useRef<SVGSVGElement>(null);
  const hasBand = data.upper.length > 0;
  return (
    <>
      <div
        role="slider"
        aria-label="波形の再生位置"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={`${percent.toFixed(1)}%`}
        tabIndex={0}
        style={{ borderRadius: 12, cursor: "crosshair" }}
        onKeyDown={(event) => {
          const positions: Record<string, number> = {
            ArrowLeft: percent - 1,
            ArrowDown: percent - 1,
            ArrowRight: percent + 1,
            ArrowUp: percent + 1,
            Home: 0,
            End: 100,
          };
          const next = positions[event.key];
          if (next === undefined) return;
          event.preventDefault();
          onSeek(Math.max(0, Math.min(100, next)));
        }}
        onPointerDown={(event) => {
          const rect = svg.current?.getBoundingClientRect();
          if (rect && rect.width > 0)
            onSeek(graphPercent(((event.clientX - rect.left) / rect.width) * graph.width));
        }}
      >
        <svg
          aria-hidden="true"
          ref={svg}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          data-waveform="true"
          style={chartStyle}
        >
          <ValueGrid unit={comparison.unit} axis={data.axis} />
          {hasBand && (
            <polygon
              points={polyline([...data.upper, ...[...data.lower].reverse()])}
              fill="#dbeafe"
              opacity=".9"
              data-reference-band="true"
            />
          )}
          <polyline
            data-series="baseline"
            points={polyline(data.baseline)}
            fill="none"
            stroke="#64748b"
            strokeWidth="2.5"
            strokeDasharray="6 5"
          />
          <polyline
            data-series="target"
            points={polyline(data.target)}
            fill="none"
            stroke={colors.accent}
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <line
            data-playhead={percent}
            x1={playhead}
            x2={playhead}
            y1={graph.top}
            y2={graph.bottom}
            stroke={colors.cobalt}
            strokeWidth="1.5"
          />
          <circle cx={playhead} cy={graph.top} r="3.4" fill={colors.cobalt} />
          {[0, 50, 100].map((tick) => (
            <text
              key={tick}
              x={graphX(tick)}
              y="232"
              textAnchor="middle"
              fontSize="11"
              fill={colors.secondary}
            >
              {tick}%
            </text>
          ))}
        </svg>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 14px",
          fontSize: 11,
          color: colors.secondary,
        }}
      >
        <span>
          <i
            style={{
              display: "inline-block",
              width: 15,
              borderTop: "2px dashed #64748b",
              marginRight: 5,
              verticalAlign: "middle",
            }}
          />
          前回
        </span>
        <span>
          <i
            style={{
              display: "inline-block",
              width: 15,
              borderTop: "2px solid #0f766e",
              marginRight: 5,
              verticalAlign: "middle",
            }}
          />
          今回
        </span>
        {hasBand && (
          <span>
            <i
              style={{
                display: "inline-block",
                width: 15,
                height: 8,
                borderRadius: 2,
                background: "#dbeafe",
                marginRight: 5,
              }}
            />
            ±1SD帯
            {comparison.referenceBandSummary?.source.kind === "synthetic" ? "（合成データ）" : ""}
          </span>
        )}
      </div>
    </>
  );
}

export function TrendChart({ points, unit }: TrendProps) {
  if (!points.length) return null;
  const { curve, axis } = trendGeometry(points);
  return (
    <svg
      role="img"
      aria-label="試技の計測値の推移"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      data-trend="true"
      style={chartStyle}
    >
      <ValueGrid unit={unit} axis={axis} />
      <polyline points={polyline(curve)} fill="none" stroke={colors.accent} strokeWidth="3" />
      {curve.map(({ x, y }, index) => {
        const point = points[index];
        if (!point) return null;
        return (
          <g key={`${point.capturedAt}-${index}`}>
            <circle cx={x} cy={y} r="5" fill={colors.accent} stroke="white" strokeWidth="2" />
            <text
              x={x}
              y={y - 11}
              textAnchor="middle"
              fontSize="11"
              fontWeight="700"
              fill={colors.ink}
            >
              {point.value.toFixed(1)}
            </text>
            <text x={x} y="232" textAnchor="middle" fontSize="11" fill={colors.secondary}>
              {point.capturedAt.slice(5, 10).replace("-", "/")}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
