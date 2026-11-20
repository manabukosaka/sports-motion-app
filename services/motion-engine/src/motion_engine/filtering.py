from dataclasses import dataclass, field
from itertools import pairwise
from typing import Literal, Sequence

import numpy as np
from scipy.interpolate import CubicSpline
from scipy.signal import butter, filtfilt

from .calibration import FloatArray
from .contracts import Landmark, Landmark2D, Landmark3D, Pose2DSequence, Pose3DSequence

ORDER = 4
PADLEN = 3 * (ORDER + 1)


@dataclass(frozen=True)
class CutoffBand:
    minimum_hz: float
    maximum_hz: float

    def __post_init__(self) -> None:
        if (
            not np.isfinite([self.minimum_hz, self.maximum_hz]).all()
            or not 0 < self.minimum_hz < self.maximum_hz
        ):
            raise ValueError(
                "cutoff band must contain increasing positive finite frequencies"
            )


@dataclass(frozen=True)
class FilterSettings:
    trunk_lower: CutoffBand = field(default_factory=lambda: CutoffBand(4, 15))
    high_speed_upper: CutoffBand = field(default_factory=lambda: CutoffBand(16, 36))
    max_gap_frames: int = 4
    band_separated: bool = True

    def __post_init__(self) -> None:
        if self.max_gap_frames < 0:
            raise ValueError("maximum gap cannot be negative")


def butterworth_lowpass(
    values: FloatArray, sample_hz: float, cutoff_hz: float
) -> FloatArray:
    if values.size == 0 or values.ndim == 0 or len(values) <= PADLEN:
        raise ValueError(f"Butterworth filtering requires more than {PADLEN} samples")
    if (
        not np.isfinite(values).all()
        or not np.isfinite(sample_hz)
        or not 0 < cutoff_hz < sample_hz / 2
    ):
        raise ValueError("filtering requires finite samples and a cutoff below Nyquist")
    b, a = butter(ORDER, cutoff_hz, fs=sample_hz)
    filtered = np.asarray(
        filtfilt(b, a, values, axis=0, padlen=PADLEN), dtype=np.float64
    )
    if not np.isfinite(filtered).all():
        raise ValueError("Butterworth filter produced a non-finite result")
    return filtered


def winter_cutoff(values: FloatArray, sample_hz: float, band: CutoffBand) -> float:
    return _select_cutoff([(values, sample_hz)], band)


def _select_cutoff(
    tracks: Sequence[tuple[FloatArray, float]], band: CutoffBand
) -> float:
    upper_hz = min(band.maximum_hz, min(hz for _, hz in tracks) * 0.45)
    if not band.minimum_hz < upper_hz:
        raise ValueError("cutoff band has no usable frequencies below Nyquist")
    candidates = np.linspace(band.minimum_hz, upper_hz, 25)
    sample_count = sum(values.size for values, _ in tracks)
    residuals = np.sqrt(
        np.array(
            [
                sum(
                    np.sum(
                        (values - butterworth_lowpass(values, hz, float(cutoff))) ** 2
                    )
                    for values, hz in tracks
                )
                / sample_count
                for cutoff in candidates
            ]
        )
    )
    # Winter's noise estimate is the zero-frequency intercept of the high-frequency residual line.
    tail = slice(-8, None)
    _, intercept = np.polyfit(candidates[tail], residuals[tail], 1)
    if not np.isfinite(intercept):
        raise ValueError("non-finite residual fit")
    monotone = np.minimum.accumulate(residuals)
    return float(np.interp(intercept, monotone[::-1], candidates[::-1]))


def _runs(mask: np.ndarray[tuple[int], np.dtype[np.bool_]]) -> list[tuple[int, int]]:
    transitions = np.flatnonzero(np.diff(np.r_[False, mask, False]))
    return [
        (int(start), int(end))
        for start, end in zip(transitions[::2], transitions[1::2], strict=True)
    ]


def _landmark_columns[L: Landmark](
    frames: Sequence[Sequence[L]],
) -> dict[str, list[L | None]]:
    by_id: dict[str, list[L | None]] = {}
    for index, points in enumerate(frames):
        for point in points:
            if point.landmark_id not in by_id:
                by_id[point.landmark_id] = [None] * len(frames)
            column = by_id[point.landmark_id]
            if column[index] is not None:
                raise ValueError("duplicate landmark for the same frame")
            column[index] = point
    return by_id


def _dense[L: Landmark](points: Sequence[L | None], dimensions: int) -> FloatArray:
    values = np.full((len(points), dimensions), np.nan)
    for index, point in enumerate(points):
        if point is not None and point.missing_reason is None:
            values[index] = point.axes()
    return values


def _with_points[Pose: (Pose2DSequence, Pose3DSequence)](
    pose: Pose, max_gap_frames: int
) -> Pose:
    if max_gap_frames < 0:
        raise ValueError("maximum gap cannot be negative")
    result = pose.model_copy(deep=True)
    if max_gap_frames == 0:
        return result
    time = np.array([frame.timestamp_sec for frame in pose.frames])
    indices = np.array([frame.frame_index for frame in pose.frames])

    if isinstance(result, Pose2DSequence):
        _fill_gaps(result, time, indices, max_gap_frames, 2)
    else:
        _fill_gaps(result, time, indices, max_gap_frames, 3)
    return result


def _fill_gaps(
    pose: Pose2DSequence | Pose3DSequence,
    time: FloatArray,
    indices: np.ndarray[tuple[int], np.dtype[np.signedinteger]],
    max_gap_frames: int,
    dimensions: int,
) -> None:
    columns = _landmark_columns([frame.landmarks for frame in pose.frames])
    for name, points in columns.items():
        values = _dense(points, dimensions)
        missing = ~np.isfinite(values).all(axis=1)
        for start, end in _runs(missing):
            if (
                start < 2
                or end + 2 > len(time)
                or indices[end] - indices[start - 1] - 1 > max_gap_frames
            ):
                continue
            if any(
                point is not None and point.missing_reason == "insufficient_calibration"
                for point in points[start:end]
            ):
                continue
            support = [start - 2, start - 1, end, end + 1]
            if missing[support].any():
                continue
            filled = CubicSpline(time[support], values[support], axis=0)(
                time[start:end]
            )
            for index, coords in enumerate(filled, start):
                if isinstance(pose, Pose2DSequence):
                    new_2d = Landmark2D(
                        landmark_id=name,
                        x=float(coords[0]),
                        y=float(coords[1]),
                        confidence=None,
                        source="spline_interpolated",
                        missing_reason=None,
                    )
                    points_2d = pose.frames[index].landmarks
                    points_2d[:] = [
                        point for point in points_2d if point.landmark_id != name
                    ] + [new_2d]
                else:
                    new_3d = Landmark3D(
                        landmark_id=name,
                        x=float(coords[0]),
                        y=float(coords[1]),
                        z=float(coords[2]),
                        source="spline_interpolated",
                        missing_reason=None,
                    )
                    points_3d = pose.frames[index].landmarks
                    points_3d[:] = [
                        point for point in points_3d if point.landmark_id != name
                    ] + [new_3d]


def interpolate_image(pose: Pose2DSequence, max_gap_frames: int = 4) -> Pose2DSequence:
    return _with_points(pose, max_gap_frames)


def interpolate_3d(pose: Pose3DSequence, max_gap_frames: int = 4) -> Pose3DSequence:
    return _with_points(pose, max_gap_frames)


FilterGroup = Literal["trunk_lower", "high_speed_upper", "pooled"]


def filter_pose(
    pose: Pose3DSequence, high_speed_landmarks: frozenset[str], settings: FilterSettings
) -> tuple[Pose3DSequence, dict[FilterGroup, float]]:
    if len(pose.frames) <= PADLEN:
        raise ValueError(f"pose filtering requires more than {PADLEN} frames")
    pose = interpolate_3d(pose, settings.max_gap_frames)
    time = np.array([frame.timestamp_sec for frame in pose.frames])
    period = float(np.median(np.diff(time)))
    # Long capture gaps break the filter even when both adjacent frames have observations.
    boundaries = np.r_[0, np.flatnonzero(np.diff(time) > period * 1.5) + 1, len(time)]
    columns = _landmark_columns([frame.landmarks for frame in pose.frames])
    dense = {name: _dense(column, 3) for name, column in columns.items()}
    cutoffs: dict[FilterGroup, float] = {}
    groups: dict[FilterGroup, list[str]] = {}
    for name in columns:
        group: FilterGroup = "pooled"
        if settings.band_separated:
            group = (
                "high_speed_upper" if name in high_speed_landmarks else "trunk_lower"
            )
        groups.setdefault(group, []).append(name)

    for group, names in groups.items():
        if group == "pooled":
            band = CutoffBand(
                min(
                    settings.trunk_lower.minimum_hz,
                    settings.high_speed_upper.minimum_hz,
                ),
                max(
                    settings.trunk_lower.maximum_hz,
                    settings.high_speed_upper.maximum_hz,
                ),
            )
        else:
            band = (
                settings.high_speed_upper
                if group == "high_speed_upper"
                else settings.trunk_lower
            )
        segments: list[tuple[str, int, int, FloatArray, FloatArray]] = []
        for name in names:
            observed = np.isfinite(dense[name]).all(axis=1)
            for low, high in pairwise(boundaries):
                for start, end in _runs(observed[low:high]):
                    start, end = start + int(low), end + int(low)
                    captured = time[start:end]
                    if end - start <= PADLEN:
                        dense[name][start:end] = np.nan
                        continue
                    uniform = np.linspace(captured[0], captured[-1], len(captured))
                    values = dense[name][start:end]
                    resampled = np.column_stack(
                        [
                            np.interp(uniform, captured, values[:, axis])
                            for axis in range(3)
                        ]
                    )
                    segments.append((name, start, end, uniform, resampled))

        if not segments:
            continue
        by_time_grid: dict[tuple[int, int], list[FloatArray]] = {}
        for _, start, end, _, values in segments:
            by_time_grid.setdefault((start, end), []).append(values)
        cutoff = _select_cutoff(
            [
                (
                    np.concatenate(tracks, axis=1),
                    float((end - start - 1) / (time[end - 1] - time[start])),
                )
                for (start, end), tracks in by_time_grid.items()
            ],
            band,
        )
        cutoffs[group] = cutoff
        for name, start, end, uniform, values in segments:
            hz = (len(uniform) - 1) / (uniform[-1] - uniform[0])
            filtered = butterworth_lowpass(values, float(hz), cutoff)
            dense[name][start:end] = np.column_stack(
                [
                    np.interp(time[start:end], uniform, filtered[:, axis])
                    for axis in range(3)
                ]
            )

    for index, frame in enumerate(pose.frames):
        for position, point in enumerate(frame.landmarks):
            if point.missing_reason is not None:
                continue
            x, y, z = dense[point.landmark_id][index]
            frame.landmarks[position] = (
                point.model_copy(update={"x": float(x), "y": float(y), "z": float(z)})
                if np.isfinite([x, y, z]).all()
                else point.model_copy(
                    update={
                        "x": None,
                        "y": None,
                        "z": None,
                        "missing_reason": "low_confidence",
                    }
                )
            )
    return pose, cutoffs
