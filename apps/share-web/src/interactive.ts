import {
  type KinematicMetrics,
  type Pose3DSequence,
  type ShareReportSnapshot,
  type SkeletonPoint,
  skeletonGeometry,
  validateContract,
} from "@sports-motion/contracts";
import { renderShareReportHtml } from "./report.js";

const intervalEvents = {
  pitch_cycle: ["pitch_leg_lift", "pitch_ball_release"],
  run_stride: ["run_initial_contact", "run_next_initial_contact"],
  run_stance: ["run_initial_contact", "run_toe_off"],
  cmj_cycle: ["cmj_initiation", "cmj_peak_landing_flexion"],
  dvj_cycle: ["dvj_initial_landing_contact", "dvj_takeoff"],
} satisfies Record<
  KinematicMetrics["normalized_waveforms"][number]["interval_id"],
  [KinematicMetrics["events"][number]["event_id"], KinematicMetrics["events"][number]["event_id"]]
>;

const metricLabels: Partial<
  Record<KinematicMetrics["normalized_waveforms"][number]["metric_id"], string>
> = {
  pitch_elbow_flexion_angle: "肘の屈曲角度",
  run_knee_flexion_extension_angle: "膝の屈曲・伸展角度",
  jump_landing_knee_flexion_angle: "着地時の膝の屈曲角度",
};

function chartData(metrics: KinematicMetrics) {
  for (const waveform of metrics.normalized_waveforms) {
    const [first, last] = intervalEvents[waveform.interval_id];
    const eventTime = (id: KinematicMetrics["events"][number]["event_id"]) =>
      (
        metrics.events.find(({ event_id, side }) => event_id === id && side === waveform.side) ??
        metrics.events.find(({ event_id, side }) => event_id === id && side === undefined)
      )?.timestamp_sec;
    const start = eventTime(first);
    const end = eventTime(last);
    if (start === undefined || end === undefined || start >= end) {
      continue;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const { value } of waveform.points) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const path = waveform.points
      .map(({ normalized_time_fraction, value }, index) => {
        const x = 12 + 320 * normalized_time_fraction;
        const y = min === max ? 50 : 86 - 72 * ((value / 2 - min / 2) / (max / 2 - min / 2));
        return `${index === 0 ? "M" : "L"}${x} ${y}`;
      })
      .join(" ");
    return {
      start,
      end,
      path,
      unit: waveform.unit,
      min,
      max,
      label: metricLabels[waveform.metric_id] ?? waveform.metric_id,
    };
  }
}

interface Frame {
  index: number;
  time: number;
  points: SkeletonPoint[];
  segments: [number, number][];
}

interface ViewerData {
  frames: Frame[];
  chart: ReturnType<typeof chartData>;
}

function runViewer() {
  const canvas = document.querySelector<HTMLCanvasElement>("#skeleton-canvas");
  const chart = document.querySelector<SVGSVGElement>("#kinematic-chart");
  const curve = document.querySelector<SVGPathElement>("#kinematic-curve");
  const cursor = document.querySelector<SVGLineElement>("#chart-cursor");
  const scrubber = document.querySelector<HTMLInputElement>("#frame-scrubber");
  const orbit = document.querySelector<HTMLInputElement>("#orbit-angle");
  const frameLabel = document.querySelector<HTMLOutputElement>("#frame-label");
  const source = document.querySelector("#viewer-data");
  if (
    !canvas ||
    !chart ||
    !curve ||
    !cursor ||
    !scrubber ||
    !orbit ||
    !frameLabel ||
    !source?.textContent
  ) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const data: ViewerData = JSON.parse(source.textContent);
  const waveform = data.chart;
  if (waveform) {
    curve.setAttribute("d", waveform.path);
  }

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const { points } of data.frames) {
    for (const point of points) {
      point.forEach((meters, axis) => {
        low[axis] = Math.min(low[axis] ?? meters, meters);
        high[axis] = Math.max(high[axis] ?? meters, meters);
      });
    }
  }
  const center = low.map((min, axis) => min / 2 + (high[axis] ?? min) / 2);
  const radiusMeters = Math.max(1e-6, ...high.map((max, axis) => max / 2 - (low[axis] ?? max) / 2));

  function drawSkeleton(context: CanvasRenderingContext2D, frame: Frame, angleDegrees: number) {
    const { width, height } = context.canvas;
    context.clearRect(0, 0, width, height);
    const angleRad = angleDegrees * (Math.PI / 180);
    const sin = Math.sin(angleRad);
    const cos = Math.cos(angleRad);
    const zoomPixels = Math.min(width, height) * 0.35;
    const projected = frame.points.map(([xMeters, yMeters, zMeters]) => {
      const x = ((xMeters / 2 - (center[0] ?? 0) / 2) / radiusMeters) * 2;
      const y = ((yMeters / 2 - (center[1] ?? 0) / 2) / radiusMeters) * 2;
      const z = ((zMeters / 2 - (center[2] ?? 0) / 2) / radiusMeters) * 2;
      const horizontal = x * cos - z * sin;
      const depth = x * sin + z * cos;
      const perspective = 5 / (5 + depth);
      return {
        x: width / 2 + horizontal * perspective * zoomPixels,
        y: height / 2 - y * perspective * zoomPixels,
      };
    });
    context.strokeStyle = "#5de4c7";
    context.lineWidth = 4;
    context.lineCap = "round";
    context.beginPath();
    for (const [first, second] of frame.segments) {
      const from = projected[first];
      const to = projected[second];
      if (from && to) {
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
      }
    }
    context.stroke();
    context.fillStyle = "#e7fff9";
    for (const point of projected) {
      context.beginPath();
      context.arc(point.x, point.y, 3, 0, Math.PI * 2);
      context.fill();
    }
  }

  const draw = () => {
    const frame = data.frames[scrubber.valueAsNumber];
    if (!frame) {
      return;
    }
    drawSkeleton(context, frame, orbit.valueAsNumber);
    if (waveform && frame.time >= waveform.start && frame.time <= waveform.end) {
      const x = 12 + (320 * (frame.time - waveform.start)) / (waveform.end - waveform.start);
      cursor.setAttribute("x1", String(x));
      cursor.setAttribute("x2", String(x));
      cursor.setAttribute("visibility", "visible");
    } else {
      cursor.setAttribute("visibility", "hidden");
    }
    const index = String(frame.index);
    frameLabel.value = index;
    scrubber.setAttribute("aria-valuetext", index);
    canvas.setAttribute("data-frame", index);
    chart.setAttribute("data-frame", index);
  };
  scrubber.addEventListener("input", draw);
  orbit.addEventListener("input", draw);
  let drag: { id: number; x: number; angle: number } | undefined;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { id: event.pointerId, x: event.clientX, angle: orbit.valueAsNumber };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag?.id === event.pointerId) {
      const angle = drag.angle + event.clientX - drag.x;
      orbit.value = String(((((angle + 180) % 360) + 360) % 360) - 180);
      draw();
    }
  });
  canvas.addEventListener("lostpointercapture", () => {
    drag = undefined;
  });
  draw();
}

const styles = `<style>
  :root { font-family: system-ui, sans-serif; color: #182936; background: #edf3f4; }
  body { margin: 0; }
  main { box-sizing: border-box; max-width: 42rem; margin: auto; padding: 22px 16px 36px; }
  h1 { margin: 0 0 10px; font-size: 1.55rem; }
  h2 { margin: 0 0 10px; font-size: 1.1rem; }
  p { margin: 0 0 12px; }
  #disclaimer { padding: 10px 12px; border-left: 3px solid #047c6d; background: #fff; }
  .viewer { background: #fff; border: 1px solid #cfdddf; border-radius: 14px; padding: 12px; }
  canvas, svg { width: 100%; height: auto; border-radius: 8px; }
  canvas { background: #102632; touch-action: pan-y; }
  svg { background: #edf3f4; }
  label { display: flex; justify-content: space-between; gap: 8px; }
  input[type=range] { width: 100%; margin: 0; min-height: 36px; accent-color: #047c6d; }
  dl, li { overflow-wrap: anywhere; }
  dl { font-size: .85rem; }
  dd { margin-inline-start: 0; }
</style>`;

const jsonEscapes: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function renderInteractiveSharePageHtml(
  snapshot: ShareReportSnapshot,
  pose3d?: Pose3DSequence,
  cardToken?: string,
) {
  const html = renderShareReportHtml(snapshot);
  if (
    pose3d !== undefined &&
    (!validateContract("pose3d", pose3d) || pose3d.contract_version !== snapshot.contract_version)
  ) {
    throw new TypeError("Invalid share skeleton");
  }
  const frames =
    pose3d?.frames.map((frame) => {
      const { joints, segments } = skeletonGeometry(frame);
      return {
        index: frame.frame_index,
        time: frame.timestamp_sec,
        points: joints.map(([, point]) => point),
        segments,
      };
    }) ?? [];
  const chart = chartData(snapshot.kinematic_summary);
  const data = JSON.stringify({ frames, chart } satisfies ViewerData).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => jsonEscapes[character] ?? character,
  );
  const viewer = `<section class="viewer" aria-labelledby="viewer-heading">
<h2 id="viewer-heading">3D骨格と動作グラフ</h2>
${frames.length === 0 ? "<p>このレポートには3D骨格がありません。</p>" : ""}
<canvas id="skeleton-canvas" width="344" height="220" role="img" aria-label="3D骨格" ${frames.length === 0 ? "hidden" : ""}></canvas>
<div ${frames.length === 0 ? "hidden" : ""}>
<label for="orbit-angle">回転角度</label><input id="orbit-angle" type="range" min="-180" max="180" value="25">
<label for="frame-scrubber">フレーム <output id="frame-label" for="frame-scrubber"></output></label>
<input id="frame-scrubber" type="range" min="0" max="${Math.max(0, frames.length - 1)}" value="0">
</div>
${chart ? `<p>${chart.label}（${chart.unit}、${chart.min.toFixed(1)}–${chart.max.toFixed(1)}）</p>` : "<p>表示できる動作曲線がありません。</p>"}
<svg id="kinematic-chart" viewBox="0 0 344 100" role="img" aria-label="動作曲線" ${chart ? "" : "hidden"}>
<path d="M12 14 V86 H332" fill="none" stroke="#a4b8be"/>
<path id="kinematic-curve" fill="none" stroke="#047c6d" stroke-width="2"/>
<line id="chart-cursor" y1="8" y2="92" stroke="#ba4b2b" stroke-width="2" visibility="hidden"/>
</svg>
</section>
<script id="viewer-data" type="application/json">${data}</script>
<script>(${runViewer.toString()})();</script>`;
  const cardLink =
    cardToken === undefined
      ? ""
      : `<p><a href="/share/${encodeURIComponent(snapshot.share_link_id)}/card.svg?token=${encodeURIComponent(cardToken)}" rel="noreferrer">サマリー画像を表示</a></p>`;
  return html
    .replace("</head>", () => `${styles}</head>`)
    .replace("<dl>", () => `${cardLink}${viewer}<dl>`);
}
