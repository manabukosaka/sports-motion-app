import {
  asRadians,
  type KinematicMetrics,
  type Meters,
  metersToMillimeters,
  type Pose3DSequence,
  radToDeg,
  validateContract,
} from "@sports-motion/contracts";

function csvCell(value: string | number | null) {
  const cell = String(value ?? "");
  return /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function exportKinematicsCsv(metrics: KinematicMetrics): string {
  if (!validateContract("kinematic_metrics", metrics)) {
    throw new TypeError("Invalid kinematic metrics");
  }
  const metadata = {
    contract_version: metrics.contract_version,
    pipeline_version: metrics.provenance.pipeline_version,
    analysis_revision_id: metrics.analysis_revision_id,
    movement_type: metrics.movement_type,
    filter_spec_version: metrics.provenance.filter_spec_version,
  };
  const comments = Object.entries(metadata).map(([key, value]) => {
    const singleLine = value
      .replaceAll("\\", "\\\\")
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n");
    return `# ${key}=${csvCell(singleLine)}`;
  });
  const rows = metrics.scalar_metrics.map((metric) =>
    [
      metric.metric_id,
      metric.event_id,
      metric.value_or_null,
      metric.unit,
      metric.missing_reason_or_null,
    ]
      .map(csvCell)
      .join(","),
  );
  return [...comments, "metric_id,event_id,value,unit,missing_reason", ...rows, ""].join("\n");
}

export function exportPose3DToTrc(
  pose3d: Pose3DSequence,
  { units = "m" }: { units?: "m" | "mm" } = {},
): string {
  if (
    !validateContract("pose3d", pose3d) ||
    pose3d.coordinate_frame !== "CalibratedWorld3D" ||
    pose3d.is_metric_calibrated !== true
  ) {
    throw new TypeError("TRC requires a calibrated world-space pose");
  }
  if (units !== "m" && units !== "mm") {
    throw new TypeError("TRC units must be m or mm");
  }

  const { frames } = pose3d;
  const first = frames[0];
  const last = frames.at(-1);
  if (!last || last === first || !Number.isSafeInteger(last.frame_index + 1)) {
    throw new TypeError("TRC requires at least two frames with safe frame numbers");
  }
  const frameSpan = last.frame_index - first.frame_index;
  const dataRate = frameSpan / (last.timestamp_sec - first.timestamp_sec);
  if (!Number.isFinite(dataRate) || dataRate <= 0) {
    throw new TypeError("TRC requires a finite positive frame rate");
  }

  const markers = new Set<string>();
  const frameLandmarks = frames.map(({ landmarks }) => {
    const byMarker = new Map<string, (typeof landmarks)[number]>();
    for (const landmark of landmarks) {
      const id = landmark.landmark_id;
      if (!id || id !== id.trim() || /\p{Cc}/u.test(id) || byMarker.has(id)) {
        throw new TypeError("Invalid or duplicate TRC marker name");
      }
      markers.add(id);
      byMarker.set(id, landmark);
    }
    return byMarker;
  });
  if (markers.size === 0) {
    throw new TypeError("TRC requires at least one marker");
  }
  const names = [...markers];
  const startFrame = first.frame_index + 1;
  const coordinate = (value: Meters) => (units === "mm" ? metersToMillimeters(value) : value);

  return [
    "PathFileType\t4\t(X/Y/Z)\tpose.trc",
    "DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\tOrigDataRate\tOrigDataStartFrame\tOrigNumFrames",
    [
      dataRate,
      dataRate,
      frames.length,
      names.length,
      units,
      dataRate,
      startFrame,
      frameSpan + 1,
    ].join("\t"),
    ["Frame#", "Time", ...names.flatMap((name) => [name, "", ""])].join("\t"),
    [
      "",
      "",
      ...names.flatMap((_, index) => ["X", "Y", "Z"].map((axis) => `${axis}${index + 1}`)),
    ].join("\t"),
    "",
    ...frames.map((frame, index) => {
      const landmarks = frameLandmarks[index];
      const coordinates = names.flatMap((name) => {
        const landmark = landmarks?.get(name);
        return landmark?.missing_reason === null
          ? [
              String(coordinate(landmark.x)),
              String(coordinate(landmark.y)),
              String(coordinate(landmark.z)),
            ]
          : ["", "", ""];
      });
      return [frame.frame_index + 1, frame.timestamp_sec, ...coordinates].join("\t");
    }),
    "",
  ].join("\n");
}

export function exportWaveformsToMot(metrics: KinematicMetrics): string {
  if (!validateContract("kinematic_metrics", metrics)) {
    throw new TypeError("Invalid kinematic metrics");
  }
  const columns = metrics.normalized_waveforms
    .filter(({ unit }) => unit === "deg" || unit === "rad")
    .map(({ metric_id, interval_id, side, unit, points }) => {
      const label = [metric_id, interval_id, side].filter(Boolean).join(".");
      const samples = points.map(({ normalized_time_fraction, value }, index) => {
        const previous = points[index - 1];
        if (previous && normalized_time_fraction <= previous.normalized_time_fraction) {
          throw new TypeError("MOT waveform sample times must strictly increase");
        }
        return {
          time: normalized_time_fraction,
          value: unit === "rad" ? radToDeg(asRadians(value)) : value,
        };
      });
      return { label, samples, next: 1 };
    });
  const labels = columns.map(({ label }) => label);
  if (labels.length === 0 || new Set(labels).size !== labels.length) {
    throw new TypeError("MOT requires angle waveforms with unique column labels");
  }

  let start = 0;
  let end = 1;
  let count = 2;
  for (const { samples } of columns) {
    start = Math.max(start, samples[0]?.time ?? start);
    end = Math.min(end, samples.at(-1)?.time ?? end);
    count = Math.max(count, samples.length);
  }
  if (start >= end) {
    throw new TypeError("MOT angle waveforms must share a time interval");
  }

  // OpenSim MOT needs uniform spacing, so interpolate only within the shared interval.
  let previousPercent = -1;
  const rows = Array.from({ length: count }, (_, index) => {
    const time = index === count - 1 ? end : start + ((end - start) * index) / (count - 1);
    const percent = 100 * time;
    if (percent <= previousPercent) {
      throw new TypeError("MOT sample times cannot be represented on a strictly increasing grid");
    }
    previousPercent = percent;
    const values = columns.map((column) => {
      while ((column.samples[column.next]?.time ?? end) < time) {
        column.next += 1;
      }
      const before = column.samples[column.next - 1];
      const after = column.samples[column.next];
      if (!before || !after) {
        throw new TypeError("MOT sample is outside the waveform");
      }
      const weight = (time - before.time) / (after.time - before.time);
      return before.value * (1 - weight) + after.value * weight;
    });
    return [percent, ...values].join("\t");
  });
  return [
    "Normalized kinematics (percent_0_to_100)",
    "version=1",
    `nRows=${rows.length}`,
    `nColumns=${labels.length + 1}`,
    "inDegrees=yes",
    "endheader",
    ["time", ...labels].join("\t"),
    ...rows,
    "",
  ].join("\n");
}
