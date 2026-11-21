from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from math import isfinite
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

from .contracts import (
    AnalysisProvenance,
    Frame,
    Landmark3D,
    Pose2DSequence,
    Pose3DSequence,
)


@dataclass(frozen=True)
class VideoMetadata:
    fps: float
    frame_count: int
    width_px: int
    height_px: int


@dataclass(frozen=True)
class VideoFrame:
    frame_index: int
    timestamp_sec: float
    bgr: NDArray[np.uint8]


@contextmanager
def _capture(path: Path) -> Iterator[tuple[cv2.VideoCapture, VideoMetadata]]:
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise ValueError(f"cannot open video: {path}")
        fps, count, width, height = (
            capture.get(property_id)
            for property_id in (
                cv2.CAP_PROP_FPS,
                cv2.CAP_PROP_FRAME_COUNT,
                cv2.CAP_PROP_FRAME_WIDTH,
                cv2.CAP_PROP_FRAME_HEIGHT,
            )
        )
        if (
            not isfinite(fps)
            or fps <= 0
            or any(
                not isfinite(value) or value < 1 or value != int(value)
                for value in (count, width, height)
            )
        ):
            raise ValueError("video requires positive FPS, frame count and dimensions")
        yield capture, VideoMetadata(fps, int(count), int(width), int(height))
    finally:
        capture.release()


def read_video_metadata(path: Path) -> VideoMetadata:
    with _capture(path) as (_, metadata):
        return metadata


def iter_video_frames(path: Path) -> Iterator[VideoFrame]:
    """Decode BGR frames with the video backend's presentation clock."""
    with _capture(path) as (capture, metadata):
        previous = -1.0
        for index in range(metadata.frame_count):
            decoded, bgr = capture.read()
            if (
                not decoded
                or bgr is None
                or bgr.dtype != np.uint8
                or bgr.shape != (metadata.height_px, metadata.width_px, 3)
            ):
                raise ValueError(f"cannot decode video frame {index}")
            timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if not isfinite(timestamp) or timestamp <= previous or timestamp < 0:
                raise ValueError(
                    f"missing or non-monotonic video timestamp at frame {index}"
                )
            previous = timestamp
            yield VideoFrame(index, timestamp, np.asarray(bgr, dtype=np.uint8))
        if capture.read()[0]:
            raise ValueError("decoded video exceeds its advertised frame count")


def center_on_hips(pose: Pose3DSequence) -> Pose3DSequence:
    if pose.coordinate_frame != "HipRelative3D" or pose.is_metric_calibrated:
        raise TypeError("hip centering requires hip-relative estimates")
    frames = []
    for frame in pose.frames:
        points = {point.landmark_id: point for point in frame.landmarks}
        if len(points) != len(frame.landmarks):
            raise ValueError("duplicate landmark ID in monocular frame")
        hips = [points.get(name) for name in ("left_hip", "right_hip")]
        origin: NDArray[np.float64] | None
        if all(hip is not None and hip.missing_reason is None for hip in hips):
            origin = np.mean([hip.axes() for hip in hips if hip is not None], axis=0)
        else:
            pelvis = points.get("pelvis")
            origin = (
                np.array(pelvis.axes(), dtype=np.float64)
                if pelvis is not None and pelvis.missing_reason is None
                else None
            )
        landmarks = []
        for point in frame.landmarks:
            if point.missing_reason is not None:
                landmarks.append(point)
            elif origin is None:
                landmarks.append(
                    point.model_copy(
                        update={
                            "x": None,
                            "y": None,
                            "z": None,
                            "missing_reason": "occluded",
                        }
                    )
                )
            else:
                x, y, z = np.array(point.axes(), dtype=np.float64) - origin
                landmarks.append(
                    point.model_copy(
                        update={"x": float(x), "y": float(y), "z": float(z)}
                    )
                )
        frames.append(frame.model_copy(update={"landmarks": landmarks}))
    return pose.model_copy(update={"frames": frames, "bone_length_stability_mm": None})


def lift_geometric(
    observations: Pose2DSequence | None,
    video: Path | None,
    provenance: AnalysisProvenance,
) -> Pose3DSequence:
    """Embed normalized pixels in the image plane under weak perspective.

    X points image-right, Y up and Z toward the camera. A lone pixel does not
    identify depth, so the reference lift uses zero depth for every point.
    """
    if observations is None:
        raise ValueError("the geometric lift needs Image2D observations")
    scale = max(observations.width_px, observations.height_px)
    frames = [
        Frame[Landmark3D](
            frame_index=frame.frame_index,
            timestamp_sec=frame.timestamp_sec,
            landmarks=[
                Landmark3D(
                    landmark_id=point.landmark_id,
                    x=point.x / scale if point.x is not None else None,
                    y=-point.y / scale if point.y is not None else None,
                    z=0.0 if point.missing_reason is None else None,
                    source=point.source,
                    missing_reason=point.missing_reason,
                )
                for point in frame.landmarks
            ],
        )
        for frame in observations.frames
    ]
    return center_on_hips(
        Pose3DSequence(
            contract_version=observations.contract_version,
            coordinate_frame="HipRelative3D",
            unit="m",
            is_metric_calibrated=False,
            provenance=provenance,
            frames=frames,
            bone_length_stability_mm=None,
        )
    )
