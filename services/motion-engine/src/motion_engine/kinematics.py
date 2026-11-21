from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import pairwise
from math import atan2, isfinite
from typing import NamedTuple

import numpy as np
from scipy.spatial.transform import Rotation

from .calibration import FloatArray
from .contracts import (
    CaptureEvent,
    CaptureEventID,
    EventID,
    Frame,
    IntervalID,
    KinematicMetrics,
    Landmark3D,
    MetricID,
    MissingReason,
    Movement,
    NormalizedPoint,
    NormalizedWaveform,
    Plane,
    Pose3DSequence,
    ScalarMetric,
    Side,
    Unit,
)
from .units import (
    CalibratedWorld3D,
    HipRelative3D,
    Radians,
    RadiansPerSecond,
    TimestampSeconds,
)

ROTATION_TOLERANCE = 1e-9
AngularPoint = CalibratedWorld3D | HipRelative3D


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
    origin_m: AngularPoint
    rotation: FloatArray

    def __post_init__(self) -> None:
        if not isinstance(self.origin_m, (CalibratedWorld3D, HipRelative3D)):
            raise TypeError(
                "anatomical frame requires world or hip-relative coordinates"
            )
        rotation = verify_rotation(self.rotation).copy()
        rotation.setflags(write=False)
        object.__setattr__(self, "rotation", rotation)


def _difference(a: AngularPoint, b: AngularPoint) -> FloatArray:
    if not isinstance(a, (CalibratedWorld3D, HipRelative3D)) or type(a) is not type(b):
        raise TypeError("anatomical landmarks require matching 3D coordinate frames")
    return np.asarray(a.axes()) - b.axes()


def _midpoint(a: AngularPoint, b: AngularPoint) -> AngularPoint:
    x, y, z = np.asarray(b.axes()) + _difference(a, b) / 2
    return type(a)(x=float(x), y=float(y), z=float(z))


def _long_axis_frame(
    origin: AngularPoint, superior: FloatArray, right: FloatArray
) -> AnatomicalFrame:
    y = _direction(superior)
    x = _direction(np.cross(y, right))
    return AnatomicalFrame(origin, np.column_stack((x, y, np.cross(x, y))))


def pelvis_frame(
    left_asis: AngularPoint,
    right_asis: AngularPoint,
    left_psis: AngularPoint,
    right_psis: AngularPoint,
) -> AnatomicalFrame:
    """Wu et al. (2002), DOI 10.1016/S0021-9290(01)00222-6. X anterior, Y superior, Z right."""
    origin = _midpoint(left_asis, right_asis)
    z = _direction(_difference(right_asis, left_asis))
    posterior = _midpoint(left_psis, right_psis)
    y = _direction(np.cross(z, _difference(origin, posterior)))
    return AnatomicalFrame(origin, np.column_stack((np.cross(y, z), y, z)))


def thorax_frame(
    jugular_notch: AngularPoint,
    c7: AngularPoint,
    xiphoid: AngularPoint,
    t8: AngularPoint,
) -> AnatomicalFrame:
    """Wu et al. (2005), DOI 10.1016/j.jbiomech.2004.05.042, §2.3.1."""
    superior = _difference(_midpoint(jugular_notch, c7), _midpoint(xiphoid, t8))
    right = np.cross(_difference(jugular_notch, c7), superior)
    return _long_axis_frame(jugular_notch, superior, right)


def humerus_frame(
    glenohumeral_center: AngularPoint,
    left_epicondyle: AngularPoint,
    right_epicondyle: AngularPoint,
) -> AnatomicalFrame:
    """Wu et al. (2005), epicondyle-based humeral frame, §2.3.4."""
    elbow = _midpoint(left_epicondyle, right_epicondyle)
    return _long_axis_frame(
        glenohumeral_center,
        _difference(glenohumeral_center, elbow),
        _difference(right_epicondyle, left_epicondyle),
    )


def femur_frame(
    hip_center: AngularPoint,
    left_epicondyle: AngularPoint,
    right_epicondyle: AngularPoint,
) -> AnatomicalFrame:
    """Wu et al. (2002), proximal long axis and rightward epicondylar axis."""
    knee = _midpoint(left_epicondyle, right_epicondyle)
    return _long_axis_frame(
        hip_center,
        _difference(hip_center, knee),
        _difference(right_epicondyle, left_epicondyle),
    )


def tibia_frame(
    knee_center: AngularPoint,
    left_malleolus: AngularPoint,
    right_malleolus: AngularPoint,
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
    if type(femur.origin_m) is not type(tibia.origin_m):
        raise TypeError("joint axes require matching 3D coordinate frames")
    femoral_z, floating, tibial_y = _joint_axes(femur, tibia.rotation[:, 1])
    tibial_x, tibial_z = tibia.rotation[:, 0], tibia.rotation[:, 2]
    return KneeAngles(
        Radians(value=-_z_rotation(femur, floating)),
        Radians(value=-float(np.arcsin(np.clip(femoral_z @ tibial_y, -1, 1)))),
        Radians(value=atan2(float(floating @ tibial_z), float(floating @ tibial_x))),
    )


def elbow_flexion(
    humerus: AnatomicalFrame,
    elbow: AngularPoint,
    distal_forearm: AngularPoint,
) -> Radians:
    """Wu et al. (2005), proximal Z and floating axis of the Z–X–Y elbow JCS."""
    if type(humerus.origin_m) is not type(elbow):
        raise TypeError("joint axes require matching 3D coordinate frames")
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
        "pitch_mir",
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
BONE_LINKS = (
    ("hip", "knee"),
    ("knee", "ankle"),
    ("shoulder", "elbow"),
    ("elbow", "wrist"),
)
LANDING_EVENTS: dict[Movement, tuple[CaptureEventID, ...]] = {
    "cmj": ("cmj_initial_landing_contact", "cmj_peak_landing_flexion"),
    "dvj": ("dvj_initial_landing_contact", "dvj_peak_landing_flexion"),
}
PITCH_SPEEDS: tuple[tuple[MetricID, MetricID, MetricID | None, Plane, int], ...] = (
    (
        "pitch_pelvis_rotation_angle",
        "pitch_pelvis_peak_rotation_angular_velocity",
        "pitch_pelvis_peak_rotation_timing",
        "transverse",
        0,
    ),
    (
        "pitch_thorax_rotation_angle",
        "pitch_thorax_peak_rotation_angular_velocity",
        "pitch_thorax_peak_rotation_timing",
        "transverse",
        0,
    ),
    (
        "pitch_shoulder_axial_rotation_angle",
        "pitch_shoulder_peak_internal_rotation_angular_velocity",
        None,
        "local_axis",
        1,
    ),
    (
        "pitch_elbow_flexion_angle",
        "pitch_elbow_peak_extension_angular_velocity",
        None,
        "sagittal",
        -1,
    ),
)


@dataclass(frozen=True)
class AngleSample:
    radians: float | None
    reason: MissingReason | None = None


@dataclass(frozen=True)
class AngleTrack:
    metric_id: MetricID
    plane: Plane
    samples: list[AngleSample]
    stance_only: bool = False


def _joint_center_flexion(
    proximal: AngularPoint, joint: AngularPoint, distal: AngularPoint
) -> float:
    upper = _direction(_difference(joint, proximal))
    lower = _direction(_difference(distal, joint))
    return atan2(float(np.linalg.norm(np.cross(upper, lower))), float(upper @ lower))


def _frame_points(frame: Frame[Landmark3D], metric: bool) -> dict[str, AngularPoint]:
    point_type = CalibratedWorld3D if metric else HipRelative3D
    points: dict[str, AngularPoint] = {
        landmark.landmark_id: point_type(x=landmark.x, y=landmark.y, z=landmark.z)
        for landmark in frame.landmarks
        if landmark.x is not None and landmark.y is not None and landmark.z is not None
    }
    for side in ("left", "right"):
        for center, pair in (
            ("knee", ("knee_left_epicondyle", "knee_right_epicondyle")),
            ("ankle", ("ankle_left_malleolus", "ankle_right_malleolus")),
            ("elbow", ("elbow_left_epicondyle", "elbow_right_epicondyle")),
        ):
            key = f"{side}_{center}"
            first, second = (points.get(f"{side}_{name}") for name in pair)
            if key not in points and first is not None and second is not None:
                points[key] = _midpoint(first, second)
    return points


def _angles_for_frame(
    get: Callable[[str], AngularPoint],
    missing: dict[str, MissingReason | None],
    movement: Movement,
    side: Side,
    world_basis: FloatArray | None,
    projected: bool,
    metric: bool,
) -> list[tuple[MetricID, Plane, AngleSample, bool]]:
    sign = 1 if side == "right" else -1

    def point(name: str) -> AngularPoint:
        return get(f"{side}_{name}")

    def sample(
        metric_id: MetricID,
        plane: Plane,
        measure: Callable[[], float],
        stance_only: bool = False,
    ) -> tuple[MetricID, Plane, AngleSample, bool]:
        try:
            value = AngleSample(measure())
        except KeyError as error:
            name = str(error.args[0])
            reason = (
                "unidentifiable_axis"
                if not metric and name not in missing
                else missing.get(name) or "occluded"
            )
            value = AngleSample(None, reason)
        except ValueError:
            value = AngleSample(None, "unidentifiable_axis")
        return metric_id, plane, value, stance_only

    def pelvis() -> AnatomicalFrame:
        return pelvis_frame(
            *(
                get(name)
                for name in ("left_asis", "right_asis", "left_psis", "right_psis")
            )
        )

    def thorax() -> AnatomicalFrame:
        return thorax_frame(
            *(get(name) for name in ("jugular_notch", "c7", "xiphoid", "t8"))
        )

    def humerus() -> AnatomicalFrame:
        return humerus_frame(
            point("shoulder"),
            point("elbow_left_epicondyle"),
            point("elbow_right_epicondyle"),
        )

    def elbow() -> float:
        if not projected:
            try:
                return elbow_flexion(
                    humerus(),
                    _midpoint(
                        point("elbow_left_epicondyle"), point("elbow_right_epicondyle")
                    ),
                    point("wrist"),
                ).value
            except KeyError:
                if metric:
                    raise
        return _joint_center_flexion(point("shoulder"), point("elbow"), point("wrist"))

    def shoulder_rotation() -> float:
        if projected:
            raise ValueError("axial rotation requires depth")
        relative = thorax().rotation.T @ humerus().rotation
        # Wu et al. (2005), §2.4.7. Choose negative X elevation in Y-X-Y.
        if np.hypot(relative[1, 0], relative[1, 2]) < 1e-9:
            raise ValueError("shoulder twist is singular at this elevation")
        axial = atan2(float(-sign * relative[1, 0]), float(sign * relative[1, 2]))
        return sign * axial

    def heading(frame: Callable[[], AnatomicalFrame]) -> float:
        if world_basis is None:
            raise ValueError("heading requires forward and vertical axes")
        anterior = frame().rotation[:, 0] @ world_basis
        if np.hypot(anterior[0], anterior[2]) < 1e-9:
            raise ValueError("heading is undefined for a vertical segment")
        return atan2(float(-anterior[2]), float(anterior[0]))

    if movement == "baseball_pitching":
        return [
            sample(
                "pitch_pelvis_rotation_angle", "transverse", lambda: heading(pelvis)
            ),
            sample(
                "pitch_thorax_rotation_angle", "transverse", lambda: heading(thorax)
            ),
            sample(
                "pitch_shoulder_axial_rotation_angle", "local_axis", shoulder_rotation
            ),
            sample("pitch_elbow_flexion_angle", "sagittal", elbow),
        ]

    def knee() -> KneeAngles:
        if projected:
            raise ValueError("knee joint axes require depth")
        left, right = point("knee_left_epicondyle"), point("knee_right_epicondyle")
        femur = femur_frame(point("hip"), left, right)
        tibia = tibia_frame(
            _midpoint(left, right),
            point("ankle_left_malleolus"),
            point("ankle_right_malleolus"),
        )
        return knee_joint_angles(femur, tibia)

    def knee_flexion() -> float:
        if not projected:
            try:
                return knee().flexion.value
            except KeyError:
                if metric:
                    raise
        return _joint_center_flexion(point("hip"), point("knee"), point("ankle"))

    def thigh_axis() -> FloatArray:
        return _direction(_difference(point("hip"), point("knee")))

    def hip_flexion() -> float:
        if projected:
            raise ValueError("hip joint axes require depth")
        proximal = pelvis()
        _, floating, _ = _joint_axes(proximal, thigh_axis())
        return _z_rotation(proximal, floating)

    def hip_adduction() -> float:
        if projected:
            raise ValueError("hip joint axes require depth")
        return sign * float(
            np.arcsin(np.clip(pelvis().rotation[:, 2] @ thigh_axis(), -1, 1))
        )

    def ankle_dorsiflexion() -> float:
        if projected:
            raise ValueError("ankle joint axes require depth")
        # Wu et al. (2002), §3.3–3.5. The plantar normal approximates calcaneal Y.
        left, right = point("ankle_left_malleolus"), point("ankle_right_malleolus")
        ankle = _midpoint(left, right)
        lateral = _direction(_difference(right, left))
        anterior = _direction(np.cross(_difference(point("knee"), ankle), lateral))
        shank = AnatomicalFrame(
            ankle, np.column_stack((anterior, np.cross(lateral, anterior), lateral))
        )
        heel = point("heel")
        foot_y = sign * np.cross(
            _difference(point("fifth_metatarsal"), heel),
            _difference(point("foot_index"), heel),
        )
        _, floating, _ = _joint_axes(shank, foot_y)
        return _z_rotation(shank, floating)

    def pelvic_obliquity() -> float:
        if world_basis is None:
            raise ValueError("pelvic obliquity requires vertical and lateral axes")
        lateral = pelvis().rotation[:, 2] @ world_basis
        if np.hypot(lateral[1], lateral[2]) < 1e-9:
            raise ValueError("pelvic axis has no frontal component")
        return sign * atan2(float(lateral[1]), float(lateral[2]))

    if movement == "running":
        return [
            sample("run_hip_flexion_extension_angle", "sagittal", hip_flexion),
            sample(
                "run_ankle_dorsiflexion_plantarflexion_angle",
                "sagittal",
                ankle_dorsiflexion,
            ),
            sample("run_pelvic_obliquity_angle", "frontal", pelvic_obliquity, True),
            sample("run_hip_adduction_angle", "frontal", hip_adduction, True),
            sample("run_knee_flexion_extension_angle", "sagittal", knee_flexion),
        ]
    return [
        sample("jump_landing_hip_flexion_angle", "sagittal", hip_flexion),
        sample("jump_landing_ankle_dorsiflexion_angle", "sagittal", ankle_dorsiflexion),
        sample(
            "jump_landing_knee_abduction_angle",
            "frontal",
            lambda: sign * knee().abduction.value,
        ),
        sample("jump_landing_knee_flexion_angle", "sagittal", knee_flexion),
    ]


def _scalar(
    metric: MetricID,
    event: EventID,
    unit: Unit,
    plane: Plane,
    value: float | None,
    reason: MissingReason | None,
    side: Side | None = None,
) -> ScalarMetric:
    if value is not None and not isfinite(value):
        value, reason = None, "low_confidence"
    return ScalarMetric(
        metric_id=metric,
        event_id=event,
        unit=unit,
        anatomical_plane=plane,
        value_or_null=value,
        missing_reason_or_null=reason,
        **({"side": side} if side is not None else {}),
    )


def _interval(
    positions: dict[CaptureEventID, int], first: CaptureEventID, last: CaptureEventID
) -> slice | None:
    start, end = positions.get(first), positions.get(last)
    if start is None or end is None:
        return None
    if start >= end:
        raise ValueError("event interval requires ordered start and end captures")
    return slice(start, end + 1)


def _track_values(
    track: AngleTrack, section: slice
) -> tuple[FloatArray, MissingReason | None]:
    samples = track.samples[section]
    return (
        np.unwrap(np.array([s.radians for s in samples], dtype=np.float64))
        if all(s.radians is not None for s in samples)
        else np.empty(0),
        next((s.reason for s in samples if s.reason is not None), None),
    )


def _pitch_peaks(
    tracks: list[AngleTrack],
    captured: list[TimestampSeconds],
    section: slice,
    side: Side,
) -> list[ScalarMetric]:
    result = []
    for angle_id, speed_id, timing_id, plane, direction in PITCH_SPEEDS:
        track = next(track for track in tracks if track.metric_id == angle_id)
        values, reason = _track_values(track, section)
        speed = timing = None
        if len(values):
            try:
                rates = np.rad2deg(_differentiate(values, _seconds(captured)))
            except ValueError:
                reason = "low_confidence"
            else:
                magnitudes = np.abs(rates) if direction == 0 else direction * rates
                peak = int(np.argmax(magnitudes))
                speed = max(0.0, float(magnitudes[peak]))
                if speed < 1e-9:
                    speed = 0.0
                if speed > 0:
                    first, last = captured[0].timestamp_sec, captured[-1].timestamp_sec
                    timing = (captured[peak].timestamp_sec - first) / (last - first)
        result.append(
            _scalar(speed_id, "pitch_cycle", "deg_per_s", plane, speed, reason, side)
        )
        if timing_id is not None:
            result.append(
                _scalar(
                    timing_id,
                    "pitch_cycle",
                    "dimensionless",
                    "temporal",
                    timing,
                    None if timing is not None else reason or "unidentifiable_axis",
                    side,
                )
            )
    return result


def _linear_metrics(
    movement: Movement,
    positions: dict[CaptureEventID, int],
    frames: list[dict[str, AngularPoint]],
    timestamps: list[TimestampSeconds],
    world_basis: FloatArray | None,
    side: Side,
) -> list[ScalarMetric]:
    if movement == "running":
        start, end = (
            positions.get("run_initial_contact"),
            positions.get("run_next_initial_contact"),
        )
        reason: MissingReason = (
            "insufficient_calibration" if world_basis is None else "occluded"
        )
        length = speed = None
        if start is not None and end is not None and world_basis is not None:
            first, last = (frames[index].get(f"{side}_heel") for index in (start, end))
            if isinstance(first, CalibratedWorld3D) and isinstance(
                last, CalibratedWorld3D
            ):
                length = float(_difference(last, first) @ world_basis[:, 0])
                if length >= 0:
                    speed = length / (
                        timestamps[end].timestamp_sec - timestamps[start].timestamp_sec
                    )
                else:
                    length, reason = None, "low_confidence"
        return [
            _scalar(
                "run_stride_length",
                "run_stride",
                "m",
                "temporal",
                length,
                reason if length is None else None,
                side,
            ),
            _scalar(
                "run_mean_forward_speed",
                "run_stride",
                "m_per_s",
                "temporal",
                speed,
                reason if speed is None else None,
                side,
            ),
        ]

    takeoff: CaptureEventID = "cmj_takeoff" if movement == "cmj" else "dvj_takeoff"
    landing: CaptureEventID = (
        "cmj_initial_landing_contact"
        if movement == "cmj"
        else "dvj_rebound_landing_contact"
    )
    start = positions.get(takeoff)
    flight = _interval(positions, takeoff, landing)
    reason = "insufficient_calibration" if world_basis is None else "occluded"
    rise = speed = None
    if start is not None and world_basis is not None:
        vertical = world_basis[:, 1]
        if flight is not None:
            com = [frame.get("center_of_mass") for frame in frames[flight]]
            if all(isinstance(point, CalibratedWorld3D) for point in com):
                heights = (
                    np.array([point.axes() for point in com if point is not None])
                    @ vertical
                )
                rise = float(np.max(heights) - heights[0])
        # Use the samples immediately before and after take-off on the capture clock.
        section = slice(max(start - 1, 0), start + 2)
        points = [frame.get("center_of_mass") for frame in frames[section]]
        if len(points) >= 2 and all(
            isinstance(point, CalibratedWorld3D) for point in points
        ):
            calibrated = [
                point for point in points if isinstance(point, CalibratedWorld3D)
            ]
            try:
                velocity = linear_velocity_m_per_s(calibrated, timestamps[section])
            except ValueError:
                reason = "low_confidence"
            else:
                speed = float(velocity[start - (section.start or 0)] @ vertical)
    return [
        _scalar(
            "jump_com_rise",
            takeoff,
            "m",
            "vertical_axis",
            rise,
            reason if rise is None else None,
        ),
        _scalar(
            "jump_takeoff_vertical_com_velocity",
            takeoff,
            "m_per_s",
            "vertical_axis",
            speed,
            reason if speed is None else None,
        ),
    ]


def _cadence(
    events: Sequence[CaptureEvent], captured: list[TimestampSeconds], section: slice
) -> float | None:
    first, last = (
        captured[section][0].timestamp_sec,
        captured[section][-1].timestamp_sec,
    )
    contacts = {
        (event.timestamp_sec, event.side)
        for event in events
        if event.event_id in ("run_initial_contact", "run_next_initial_contact")
        and event.side is not None
        and first <= event.timestamp_sec <= last
    }
    steps = sorted(contacts)
    if len(steps) < 2 or any(a[0] == b[0] or a[1] == b[1] for a, b in pairwise(steps)):
        return None
    return 60 * (len(steps) - 1) / (steps[-1][0] - steps[0][0])


def calculate_kinematics(
    pose: Pose3DSequence,
    movement: Movement,
    events: Sequence[CaptureEvent],
    analysis_revision_id: str,
    *,
    world_basis: FloatArray | None = None,
    projected: bool = False,
) -> tuple[Pose3DSequence, KinematicMetrics, FloatArray]:
    """Calculate angles and event metrics. Basis columns are forward, up and right.

    Jump translation metrics use the supplied whole-body center_of_mass landmark.
    """
    if world_basis is not None:
        if pose.coordinate_frame != "CalibratedWorld3D":
            raise TypeError("metric axes require calibrated world coordinates")
        world_basis = verify_rotation(world_basis)
    metric = pose.coordinate_frame == "CalibratedWorld3D"
    if metric != pose.is_metric_calibrated:
        raise TypeError("coordinate frame and calibration flag disagree")
    spec = METRICS[movement]
    by_frame = {frame.frame_index: index for index, frame in enumerate(pose.frames)}
    timestamps = [
        TimestampSeconds(timestamp_sec=frame.timestamp_sec) for frame in pose.frames
    ]
    sides: tuple[Side, ...] = ("right", "left")
    groups: dict[Side | None, dict[CaptureEventID, int]] = {
        None: {},
        "left": {},
        "right": {},
    }
    for event in events:
        index = by_frame.get(event.frame_index)
        if index is None or timestamps[index].timestamp_sec != event.timestamp_sec:
            raise ValueError("event must match a captured frame and timestamp")
        if event.event_id in groups[event.side]:
            raise ValueError("duplicate event on the selected side")
        groups[event.side][event.event_id] = index

    frames = [_frame_points(frame, metric) for frame in pose.frames]
    missing = [
        {p.landmark_id: p.missing_reason for p in frame.landmarks}
        for frame in pose.frames
    ]
    stability = []
    if metric:
        for side in sides:
            for link in BONE_LINKS:
                first, second = (f"{side}_{name}" for name in link)
                endpoints = [(frame.get(first), frame.get(second)) for frame in frames]
                sd = bone_length_sd_mm(
                    [
                        (a, b)
                        for a, b in endpoints
                        if isinstance(a, CalibratedWorld3D)
                        and isinstance(b, CalibratedWorld3D)
                    ]
                )
                if sd is not None:
                    stability.append(sd)
    pose = pose.model_copy(
        update={"bone_length_stability_mm": max(stability, default=None)}
    )

    scalars: list[ScalarMetric] = []
    waveforms: list[NormalizedWaveform] = []
    series = np.full(len(frames), np.nan)
    active_sides = tuple(side for side in sides if groups[side])
    if movement in LANDING_EVENTS and (groups[None] or active_sides):
        active_sides = sides
    elif not active_sides:
        active_sides = ("right",)
    if movement in LANDING_EVENTS:
        jump_events = groups["left"] | groups["right"] | groups[None]
        scalars.extend(
            _linear_metrics(
                movement, jump_events, frames, timestamps, world_basis, active_sides[0]
            )
        )

    cadence: float | None = None
    for side in active_sides:
        positions = (
            jump_events | groups[side]
            if movement in LANDING_EVENTS
            else groups[None] | groups[side]
        )
        positions = {
            event_id: index
            for event_id, index in positions.items()
            if event_id.startswith(spec.first.split("_", 1)[0] + "_")
        }
        section = _interval(positions, spec.first, spec.last)
        stance = (
            _interval(positions, "run_initial_contact", "run_toe_off")
            if movement == "running"
            else None
        )
        measured = [
            _angles_for_frame(
                frame.__getitem__,
                reasons,
                movement,
                side,
                world_basis,
                projected,
                metric,
            )
            for frame, reasons in zip(frames, missing, strict=True)
        ]
        tracks = [
            AngleTrack(
                column[0][0], column[0][1], [entry[2] for entry in column], column[0][3]
            )
            for column in zip(*measured, strict=True)
        ]
        if side == active_sides[0]:
            primary = next(
                track for track in tracks if track.metric_id == spec.metric_id
            )
            series = np.rad2deg(
                np.array(
                    [sample.radians for sample in primary.samples], dtype=np.float64
                )
            )
        if movement == "running":
            scalars.extend(
                _linear_metrics(
                    movement, positions, frames, timestamps, world_basis, side
                )
            )
            if section is not None and cadence is None:
                cadence = _cadence(events, timestamps, section)
        elif movement == "baseball_pitching" and section is not None:
            scalars.extend(_pitch_peaks(tracks, timestamps[section], section, side))

        for track in tracks:
            interval: IntervalID = "run_stance" if track.stance_only else spec.interval
            window = stance if track.stance_only else section
            if window is not None:
                values, _ = _track_values(track, window)
                if len(values):
                    captured = timestamps[window]
                    waveforms.append(
                        NormalizedWaveform(
                            metric_id=track.metric_id,
                            interval_id=interval,
                            unit="deg",
                            anatomical_plane=track.plane,
                            side=side,
                            points=normalize_events(
                                captured, np.rad2deg(values), captured[0], captured[-1]
                            ),
                        )
                    )
            for event_id, index in positions.items():
                if (
                    movement in LANDING_EVENTS
                    and event_id not in LANDING_EVENTS[movement]
                ):
                    continue
                if track.stance_only and event_id not in (
                    "run_initial_contact",
                    "run_mid_stance",
                    "run_toe_off",
                ):
                    continue
                value = track.samples[index]
                scalars.append(
                    _scalar(
                        track.metric_id,
                        event_id,
                        "deg",
                        track.plane,
                        None
                        if value.radians is None
                        else float(np.rad2deg(value.radians)),
                        value.reason,
                        side,
                    )
                )

    if movement == "running":
        scalars.insert(
            0,
            _scalar(
                "run_cadence",
                "run_stride",
                "spm",
                "temporal",
                cadence,
                None if cadence is not None else "occluded",
            ),
        )
    return (
        pose,
        KinematicMetrics(
            contract_version=pose.contract_version,
            analysis_revision_id=analysis_revision_id,
            movement_type=movement,
            provenance=pose.provenance,
            events=list(events),
            scalar_metrics=scalars,
            normalized_waveforms=waveforms,
        ),
        series,
    )
