from collections.abc import Mapping, Sequence
from typing import Literal

import cv2
import numpy as np
from numpy.typing import NDArray

from .calibration import (
    FloatArray,
    ProjectionCamera,
    points_array,
    projection_cameras,
    undistort_pixels,
    undistort_point,
)
from .contracts import (
    AnalysisProvenance,
    DLTCalibration,
    Frame,
    Landmark3D,
    MissingReason,
    ObservationSource,
    Pose2DSequence,
    Pose3DSequence,
    StereoCalibration,
)
from .units import CalibratedWorld3D, Image2D

MIN_RAY_SINE = 0.05


def triangulate_pixels(
    cameras: Sequence[ProjectionCamera],
    undistorted_px: Sequence[FloatArray],
    method: Literal["dlt", "stereo"] = "dlt",
) -> tuple[FloatArray, NDArray[np.bool_]]:
    if len(cameras) < 2 or len(cameras) != len(undistorted_px):
        raise ValueError("triangulation requires at least two matched views")
    pixels = [points_array(points, 2) for points in undistorted_px]
    n = len(pixels[0])
    if any(len(view) != n for view in pixels) or (
        method == "stereo" and len(cameras) != 2
    ):
        raise ValueError(
            "triangulation inputs must be synchronized and stereo requires two views"
        )
    if len({camera.view.view_id for camera in cameras}) != len(cameras):
        raise ValueError("triangulation requires distinct views")
    matrices = [camera.projection for camera in cameras]
    rays = [
        np.column_stack((view, np.ones(n))) @ np.linalg.inv(p[:, :3]).T
        for view, p in zip(pixels, matrices, strict=True)
    ]
    directions = [ray / np.linalg.norm(ray, axis=1, keepdims=True) for ray in rays]
    valid = np.zeros(n, dtype=np.bool_)
    for index, first in enumerate(directions):
        for second in directions[index + 1 :]:
            valid |= np.linalg.norm(np.cross(first, second), axis=1) >= MIN_RAY_SINE

    reconstructed = np.full((n, 3), np.nan)
    indices = np.flatnonzero(valid)
    if not len(indices):
        return reconstructed, valid
    selected = [view[indices] for view in pixels]
    if method == "stereo":
        homogeneous = np.asarray(
            cv2.triangulatePoints(
                matrices[0],
                matrices[1],
                selected[0].T,
                selected[1].T,
            ),
            dtype=np.float64,
        ).T
    else:
        equations = np.stack(
            [
                view[:, axis, None] * p[2] - p[axis]
                for p, view in zip(matrices, selected, strict=True)
                for axis in range(2)
            ],
            axis=1,
        )
        equations /= np.linalg.norm(equations, axis=2, keepdims=True)
        _, _, vh = np.linalg.svd(equations, full_matrices=False)
        homogeneous = vh[:, -1, :]
    finite = np.abs(homogeneous[:, 3]) > 1e-12
    world_m = homogeneous[finite, :3] / homogeneous[finite, 3, None]
    visible = np.isfinite(world_m).all(axis=1)
    for p in matrices:
        visible &= world_m @ p[2, :3] + p[2, 3] > 0
    accepted = indices[finite][visible]
    valid[:] = False
    valid[accepted] = True
    reconstructed[accepted] = world_m[visible]
    return reconstructed, valid


def triangulate_point(
    cameras: Sequence[ProjectionCamera],
    observations: Mapping[str, Image2D],
    method: Literal["dlt", "stereo"] = "dlt",
) -> CalibratedWorld3D:
    if set(observations) != {camera.view.view_id for camera in cameras}:
        raise ValueError("observations must match calibrated views")
    pixels = [
        np.array(
            [undistort_point(observations[camera.view.view_id], camera.view).axes()]
        )
        for camera in cameras
    ]
    world, valid = triangulate_pixels(cameras, pixels, method)
    if not valid[0]:
        raise ValueError("triangulation rejected parallel rays or an invalid depth")
    x, y, z = world[0]
    return CalibratedWorld3D(x=float(x), y=float(y), z=float(z))


def reconstruct(
    observations: tuple[Pose2DSequence, Pose2DSequence],
    calibration: DLTCalibration | StereoCalibration,
    provenance: AnalysisProvenance,
) -> Pose3DSequence:
    cameras, method = projection_cameras(calibration)
    views = {view.view_id: view for view in observations}
    if set(views) != {camera.view.view_id for camera in cameras}:
        raise ValueError("observations do not match calibration views")
    first, second = (views[camera.view.view_id] for camera in cameras)
    if (
        first.trial_id != second.trial_id
        or first.contract_version != second.contract_version
        or first.contract_version != calibration.contract_version
        or provenance.contract_version != calibration.contract_version
        or provenance.calibration_id != calibration.calibration_id
    ):
        raise ValueError("trial, contract or calibration mismatch")
    if len(first.frames) != len(second.frames):
        raise ValueError("views require synchronized frames")
    pixels: tuple[list[tuple[float, float]], list[tuple[float, float]]] = ([], [])
    frames: list[Frame[Landmark3D]] = []
    targets: list[tuple[list[Landmark3D], str, ObservationSource]] = []
    for left, right in zip(first.frames, second.frames, strict=True):
        if (left.frame_index, left.timestamp_sec) != (
            right.frame_index,
            right.timestamp_sec,
        ):
            raise ValueError(
                "view frame indices and capture timestamps must be synchronized"
            )
        a = {point.landmark_id: point for point in left.landmarks}
        b = {point.landmark_id: point for point in right.landmarks}
        if len(a) != len(left.landmarks) or len(b) != len(right.landmarks):
            raise ValueError("duplicate landmark ID in frame")
        landmarks: list[Landmark3D] = []
        frame = Frame[Landmark3D](
            frame_index=left.frame_index,
            timestamp_sec=left.timestamp_sec,
            landmarks=landmarks,
        )
        for name in sorted(a.keys() | b.keys()):
            # Fill in sorted order after batched triangulation.
            p, q = a.get(name), b.get(name)
            if (
                p is None
                or q is None
                or p.x is None
                or p.y is None
                or q.x is None
                or q.y is None
            ):
                reason: MissingReason = (
                    (p.missing_reason if p else None)
                    or (q.missing_reason if q else None)
                    or "occluded"
                )
                frame.landmarks.append(_landmark(name, "tracker_raw", reason))
            else:
                source: ObservationSource = "tracker_raw"
                if "spline_interpolated" in (p.source, q.source):
                    source = "spline_interpolated"
                elif "manual_edit" in (p.source, q.source):
                    source = "manual_edit"
                pixels[0].append((p.x, p.y))
                pixels[1].append((q.x, q.y))
                targets.append((frame.landmarks, name, source))
        frames.append(frame)
    if targets:
        arrays = [np.asarray(view_pixels) for view_pixels in pixels]
        corrected = [
            samples if view.lens_undistorted else undistort_pixels(samples, camera.view)
            for samples, view, camera in zip(
                arrays, (first, second), cameras, strict=True
            )
        ]
        world, valid = triangulate_pixels(cameras, corrected, method)
        for (landmarks, name, source), point, ok in zip(
            targets, world, valid, strict=True
        ):
            if ok:
                x, y, z = (float(axis) for axis in point)
                landmarks.append(
                    Landmark3D(
                        landmark_id=name,
                        x=x,
                        y=y,
                        z=z,
                        source=source,
                        missing_reason=None,
                    )
                )
            else:
                landmarks.append(_landmark(name, source, "insufficient_calibration"))

    for frame in frames:
        frame.landmarks.sort(key=lambda point: point.landmark_id)
    return Pose3DSequence(
        contract_version=first.contract_version,
        coordinate_frame="CalibratedWorld3D",
        unit="m",
        is_metric_calibrated=True,
        provenance=provenance,
        frames=frames,
        bone_length_stability_mm=None,
    )


def _landmark(
    name: str, source: ObservationSource, reason: MissingReason
) -> Landmark3D:
    return Landmark3D(
        landmark_id=name, x=None, y=None, z=None, source=source, missing_reason=reason
    )
