from collections.abc import Sequence
from dataclasses import dataclass
from math import atan2, degrees
from typing import NamedTuple

import numpy as np
from scipy.spatial.transform import Rotation

from .calibration import FloatArray
from .contracts import (
    CaptureEvent,
    CaptureEventID,
    IntervalID,
    KinematicMetrics,
    MetricID,
    MissingReason,
    Movement,
    NormalizedPoint,
    NormalizedWaveform,
    Pose3DSequence,
    ScalarMetric,
)
from .units import (
    CalibratedWorld3D,
    Radians,
    RadiansPerSecond,
    TimestampSeconds,
)

ROTATION_TOLERANCE = 1e-9


def verify_rotation(matrix: FloatArray) -> FloatArray:
    if (
        matrix.shape != (3, 3)
        or not np.isfinite(matrix).all()
        or not np.allclose(
            matrix.T @ matrix, np.eye(3), atol=ROTATION_TOLERANCE, rtol=0
        )
        or abs(np.linalg.det(matrix) - 1.0) > ROTATION_TOLERANCE
    ):
        raise ValueError("rotation must be a right-handed SO(3) matrix")
    return matrix


def normalized_quaternion(matrix: FloatArray) -> FloatArray:
    quaternion = np.asarray(
        Rotation.from_matrix(verify_rotation(matrix)).as_quat(canonical=True)
    )
    return quaternion / np.linalg.norm(quaternion)


def _direction(vector: FloatArray) -> FloatArray:
    length = np.linalg.norm(vector)
    if not np.isfinite(length) or length < 1e-9:
        raise ValueError("anatomical axis is unidentifiable")
    return np.asarray(vector / length)


@dataclass(frozen=True)
class AnatomicalFrame:
    origin_m: CalibratedWorld3D
    rotation: FloatArray

    def __post_init__(self) -> None:
        if not isinstance(self.origin_m, CalibratedWorld3D):
            raise TypeError("anatomical frame requires calibrated world coordinates")
        rotation = verify_rotation(self.rotation).copy()
        rotation.setflags(write=False)
        object.__setattr__(self, "rotation", rotation)


def _difference(a: CalibratedWorld3D, b: CalibratedWorld3D) -> FloatArray:
    if not isinstance(a, CalibratedWorld3D) or not isinstance(b, CalibratedWorld3D):
        raise TypeError("anatomical landmarks require calibrated world coordinates")
    return np.asarray(a.axes()) - b.axes()


def _midpoint(a: CalibratedWorld3D, b: CalibratedWorld3D) -> CalibratedWorld3D:
    x, y, z = np.asarray(b.axes()) + _difference(a, b) / 2
    return CalibratedWorld3D(x=float(x), y=float(y), z=float(z))


def _long_axis_frame(
    origin: CalibratedWorld3D, superior: FloatArray, right: FloatArray
) -> AnatomicalFrame:
    y = _direction(superior)
    x = _direction(np.cross(y, right))
    return AnatomicalFrame(origin, np.column_stack((x, y, np.cross(x, y))))


def pelvis_frame(
    left_asis: CalibratedWorld3D,
    right_asis: CalibratedWorld3D,
    left_psis: CalibratedWorld3D,
    right_psis: CalibratedWorld3D,
) -> AnatomicalFrame:
    """Wu et al. (2002), DOI 10.1016/S0021-9290(01)00222-6. X anterior, Y superior, Z right."""
    origin = _midpoint(left_asis, right_asis)
    z = _direction(_difference(right_asis, left_asis))
    posterior = _midpoint(left_psis, right_psis)
    y = _direction(np.cross(z, _difference(origin, posterior)))
    return AnatomicalFrame(origin, np.column_stack((np.cross(y, z), y, z)))


def thorax_frame(
    jugular_notch: CalibratedWorld3D,
    c7: CalibratedWorld3D,
    xiphoid: CalibratedWorld3D,
    t8: CalibratedWorld3D,
) -> AnatomicalFrame:
    """Wu et al. (2005), DOI 10.1016/j.jbiomech.2004.05.042, §2.3.1."""
    superior = _difference(_midpoint(jugular_notch, c7), _midpoint(xiphoid, t8))
    right = np.cross(_difference(jugular_notch, c7), superior)
    return _long_axis_frame(jugular_notch, superior, right)


def humerus_frame(
    glenohumeral_center: CalibratedWorld3D,
    left_epicondyle: CalibratedWorld3D,
    right_epicondyle: CalibratedWorld3D,
) -> AnatomicalFrame:
    """Wu et al. (2005), epicondyle-based humeral frame, §2.3.4."""
    elbow = _midpoint(left_epicondyle, right_epicondyle)
    return _long_axis_frame(
        glenohumeral_center,
        _difference(glenohumeral_center, elbow),
        _difference(right_epicondyle, left_epicondyle),
    )


def femur_frame(
    hip_center: CalibratedWorld3D,
    left_epicondyle: CalibratedWorld3D,
    right_epicondyle: CalibratedWorld3D,
) -> AnatomicalFrame:
    """Wu et al. (2002), proximal long axis and rightward epicondylar axis."""
    knee = _midpoint(left_epicondyle, right_epicondyle)
    return _long_axis_frame(
        hip_center,
        _difference(hip_center, knee),
        _difference(right_epicondyle, left_epicondyle),
    )


def tibia_frame(
    knee_center: CalibratedWorld3D,
    left_malleolus: CalibratedWorld3D,
    right_malleolus: CalibratedWorld3D,
) -> AnatomicalFrame:
    ankle = _midpoint(left_malleolus, right_malleolus)
    return _long_axis_frame(
        knee_center,
        _difference(knee_center, ankle),
        _difference(right_malleolus, left_malleolus),
    )


def _joint_axes(
    proximal: AnatomicalFrame, distal_y: FloatArray
) -> tuple[FloatArray, FloatArray, FloatArray]:
    proximal_z = proximal.rotation[:, 2]
    distal_y = _direction(distal_y)
    floating = _direction(np.cross(distal_y, proximal_z))
    return proximal_z, floating, distal_y


def _z_rotation(proximal: AnatomicalFrame, floating: FloatArray) -> float:
    return atan2(
        float(floating @ proximal.rotation[:, 1]),
        float(floating @ proximal.rotation[:, 0]),
    )


class KneeAngles(NamedTuple):
    flexion: Radians
    abduction: Radians
    internal_rotation: Radians


def knee_joint_angles(femur: AnatomicalFrame, tibia: AnatomicalFrame) -> KneeAngles:
    """Grood–Suntay JCS, DOI 10.1115/1.3138397, using right-knee signs."""
    femoral_z, floating, tibial_y = _joint_axes(femur, tibia.rotation[:, 1])
    tibial_x, tibial_z = tibia.rotation[:, 0], tibia.rotation[:, 2]
    return KneeAngles(
        Radians(value=-_z_rotation(femur, floating)),
        Radians(value=-float(np.arcsin(np.clip(femoral_z @ tibial_y, -1, 1)))),
        Radians(value=atan2(float(floating @ tibial_z), float(floating @ tibial_x))),
    )


def elbow_flexion(
    humerus: AnatomicalFrame,
    elbow: CalibratedWorld3D,
    distal_forearm: CalibratedWorld3D,
) -> Radians:
    """Wu et al. (2005), proximal Z and floating axis of the Z–X–Y elbow JCS."""
    _, floating, _ = _joint_axes(humerus, _difference(elbow, distal_forearm))
    return Radians(value=_z_rotation(humerus, floating))


def bone_length_sd_mm(
    endpoints: Sequence[tuple[CalibratedWorld3D, CalibratedWorld3D]],
) -> float | None:
    if not all(
        isinstance(point, CalibratedWorld3D) for pair in endpoints for point in pair
    ):
        raise TypeError("metric bone lengths require calibrated world coordinates")
    if len(endpoints) < 2:
        return None
    return float(
        np.std([first.distance_to(second) for first, second in endpoints]) * 1000
    )


def _seconds(timestamps: Sequence[TimestampSeconds]) -> FloatArray:
    if not all(isinstance(value, TimestampSeconds) for value in timestamps):
        raise TypeError(
            "differentiation and event normalization require capture timestamps in seconds"
        )
    values = np.array([value.timestamp_sec for value in timestamps], dtype=np.float64)
    if len(values) < 2 or np.any(np.diff(values) <= 0):
        raise ValueError(
            "capture timestamps must strictly increase and contain at least two samples"
        )
    return values


def _differentiate(values: FloatArray, time_sec: FloatArray) -> FloatArray:
    if len(values) != len(time_sec) or not np.isfinite(values).all():
        raise ValueError(
            "differentiation requires finite values on the capture time axis"
        )
    rates = np.asarray(np.gradient(values, time_sec, axis=0), dtype=np.float64)
    if not np.isfinite(rates).all():
        raise ValueError("capture samples cannot produce finite derivatives")
    return rates


def angular_velocity(
    angles: Sequence[Radians], timestamps: Sequence[TimestampSeconds]
) -> list[RadiansPerSecond]:
    """Differentiate continuous angular displacement on the capture clock."""
    if not all(isinstance(angle, Radians) for angle in angles):
        raise TypeError("angular differentiation requires radians")
    rates = _differentiate(
        np.array([angle.value for angle in angles]), _seconds(timestamps)
    )
    return [RadiansPerSecond(value=float(rate)) for rate in rates]


def linear_velocity_m_per_s(
    positions: Sequence[CalibratedWorld3D], timestamps: Sequence[TimestampSeconds]
) -> FloatArray:
    if not all(isinstance(point, CalibratedWorld3D) for point in positions):
        raise TypeError("metric velocity requires calibrated world coordinates")
    return _differentiate(
        np.array([point.axes() for point in positions]), _seconds(timestamps)
    )


def normalize_events(
    timestamps: Sequence[TimestampSeconds],
    values: FloatArray,
    start: TimestampSeconds,
    end: TimestampSeconds,
    samples: int = 101,
) -> list[NormalizedPoint]:
    time = _seconds(timestamps)
    first, last = _seconds([start, end])
    if len(values) != len(time) or values.ndim != 1 or not np.isfinite(values).all():
        raise ValueError(
            "normalization requires finite scalar values on the capture time axis"
        )
    if first < time[0] or last > time[-1] or samples < 2:
        raise ValueError(
            "event interval must lie on the capture time axis and contain at least two samples"
        )
    fractions = np.linspace(0.0, 1.0, samples)
    interpolated = np.interp(np.linspace(first, last, samples), time, values)
    return [
        NormalizedPoint(
            normalized_time_fraction=float(p),
            value=float(value),
        )
        for p, value in zip(fractions, interpolated, strict=True)
    ]


@dataclass(frozen=True)
class MetricSpec:
    metric_id: MetricID
    interval: IntervalID
    first: CaptureEventID
    last: CaptureEventID


METRICS: dict[Movement, MetricSpec] = {
    "baseball_pitching": MetricSpec(
        "pitch_elbow_flexion_angle",
        "pitch_cycle",
        "pitch_leg_lift",
        "pitch_ball_release",
    ),
    "running": MetricSpec(
        "run_knee_flexion_extension_angle",
        "run_stride",
        "run_initial_contact",
        "run_next_initial_contact",
    ),
    "cmj": MetricSpec(
        "jump_landing_knee_flexion_angle",
        "cmj_cycle",
        "cmj_initiation",
        "cmj_peak_landing_flexion",
    ),
    "dvj": MetricSpec(
        "jump_landing_knee_flexion_angle",
        "dvj_cycle",
        "dvj_initial_landing_contact",
        "dvj_takeoff",
    ),
}
ARM = (
    "right_shoulder",
    "right_elbow_left_epicondyle",
    "right_elbow_right_epicondyle",
    "right_wrist",
)
LEG = (
    "right_hip",
    "right_knee_left_epicondyle",
    "right_knee_right_epicondyle",
    "right_ankle_left_malleolus",
    "right_ankle_right_malleolus",
)
BONE_CENTERS = (
    ("right_knee", LEG[1], LEG[2]),
    ("right_ankle", LEG[3], LEG[4]),
    ("right_elbow", ARM[1], ARM[2]),
)


def _flexion(points: dict[str, CalibratedWorld3D], movement: Movement) -> Radians:
    if movement == "baseball_pitching":
        shoulder, left, right, wrist = (points[name] for name in ARM)
        return elbow_flexion(
            humerus_frame(shoulder, left, right), _midpoint(left, right), wrist
        )
    hip, left_knee, right_knee, left_ankle, right_ankle = (points[name] for name in LEG)
    femur = femur_frame(hip, left_knee, right_knee)
    tibia = tibia_frame(_midpoint(left_knee, right_knee), left_ankle, right_ankle)
    return knee_joint_angles(femur, tibia).flexion


def calculate_kinematics(
    pose: Pose3DSequence,
    movement: Movement,
    events: Sequence[CaptureEvent],
    analysis_revision_id: str,
) -> tuple[Pose3DSequence, KinematicMetrics, FloatArray]:
    if pose.coordinate_frame != "CalibratedWorld3D":
        raise ValueError("calibrated kinematics requires metric world coordinates")
    spec = METRICS[movement]
    by_frame = {frame.frame_index: index for index, frame in enumerate(pose.frames)}
    timestamps = [
        TimestampSeconds(timestamp_sec=frame.timestamp_sec) for frame in pose.frames
    ]
    event_positions: dict[CaptureEventID, int] = {}
    for event in events:
        index = by_frame.get(event.frame_index)
        if index is None or timestamps[index].timestamp_sec != event.timestamp_sec:
            raise ValueError("event must match a captured frame and timestamp")
        if event.side == "left":
            continue
        if event.event_id in event_positions:
            raise ValueError("duplicate event on the selected side")
        event_positions[event.event_id] = index
    start, end = event_positions.get(spec.first), event_positions.get(spec.last)
    if (start is None) != (end is None) or (
        start is not None and end is not None and start >= end
    ):
        raise ValueError("event interval requires ordered start and end captures")

    angles = np.full(len(pose.frames), np.nan)
    reasons: list[MissingReason | None] = []
    bones: dict[tuple[str, str], list[tuple[CalibratedWorld3D, CalibratedWorld3D]]] = {
        (proximal, distal): []
        for proximal, distal in (
            ("right_hip", "right_knee"),
            ("right_knee", "right_ankle"),
            ("right_shoulder", "right_elbow"),
            ("right_elbow", "right_wrist"),
        )
    }
    required = ARM if movement == "baseball_pitching" else LEG
    for index, frame in enumerate(pose.frames):
        points: dict[str, CalibratedWorld3D] = {}
        missing: dict[str, MissingReason] = {}
        for point in frame.landmarks:
            if point.x is not None and point.y is not None and point.z is not None:
                points[point.landmark_id] = CalibratedWorld3D(
                    x=point.x, y=point.y, z=point.z
                )
            elif point.missing_reason is not None:
                missing[point.landmark_id] = point.missing_reason
        for center, left, right in BONE_CENTERS:
            if center not in points and left in points and right in points:
                points[center] = _midpoint(points[left], points[right])
        for pair, track in bones.items():
            a, b = pair
            if a in points and b in points:
                track.append((points[a], points[b]))
        reason = next(
            (missing.get(name, "occluded") for name in required if name not in points),
            None,
        )
        if reason is None:
            try:
                angles[index] = _flexion(points, movement).value
            except ValueError:
                reason = "unidentifiable_axis"
        reasons.append(reason)

    stability = [
        sd for track in bones.values() if (sd := bone_length_sd_mm(track)) is not None
    ]
    pose = pose.model_copy(
        update={"bone_length_stability_mm": max(stability, default=None)}
    )
    metrics = [
        ScalarMetric(
            metric_id=spec.metric_id,
            event_id=event_id,
            value_or_null=degrees(angles[index]) if reasons[index] is None else None,
            unit="deg",
            anatomical_plane="sagittal",
            missing_reason_or_null=reasons[index],
            side="right",
        )
        for event_id, index in event_positions.items()
    ]
    waveforms = []
    if start is not None and end is not None:
        section = slice(start, end + 1)
        captured = timestamps[section]
        missing_reason = next(
            (reason for reason in reasons[section] if reason is not None), None
        )
        if missing_reason is None:
            waveforms.append(
                NormalizedWaveform(
                    metric_id=spec.metric_id,
                    interval_id=spec.interval,
                    unit="deg",
                    anatomical_plane="sagittal",
                    side="right",
                    points=normalize_events(
                        captured, np.rad2deg(angles[section]), captured[0], captured[-1]
                    ),
                )
            )
        if movement == "baseball_pitching":
            speed = None
            if missing_reason is None:
                velocity = angular_velocity(
                    [Radians(value=float(angle)) for angle in angles[section]], captured
                )
                speed = max(
                    0.0, -min(rate.to_degrees_per_second().value for rate in velocity)
                )
            metrics.append(
                ScalarMetric(
                    metric_id="pitch_elbow_peak_extension_angular_velocity",
                    event_id=spec.interval,
                    value_or_null=speed,
                    unit="deg_per_s",
                    anatomical_plane="sagittal",
                    side="right",
                    missing_reason_or_null=missing_reason,
                )
            )

    return (
        pose,
        KinematicMetrics(
            contract_version=pose.contract_version,
            analysis_revision_id=analysis_revision_id,
            movement_type=movement,
            provenance=pose.provenance,
            events=list(events),
            scalar_metrics=metrics,
            normalized_waveforms=waveforms,
        ),
        np.rad2deg(angles),
    )
