import importlib
from collections.abc import Iterator, Sequence
from contextlib import AbstractContextManager, closing, contextmanager, nullcontext
from dataclasses import dataclass
from hashlib import file_digest, sha256
from math import isfinite
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np
from numpy.typing import NDArray

from .contracts import (
    AnalysisProvenance,
    Frame,
    Landmark3D,
    MissingReason,
    Pose2DSequence,
    Pose3DSequence,
)
from .monocular import center_on_hips, hip_midpoint, iter_video_frames
from .pipeline import PIPELINE_VERSION, SUPPORTED_CONTRACT_VERSIONS
from .plugins import LicenseAttestation, PluginManifest

MEDIAPIPE_LANDMARK_IDS = (
    "nose",  # 0
    "left_eye_inner",
    "left_eye",
    "left_eye_outer",
    "right_eye_inner",
    "right_eye",
    "right_eye_outer",
    "left_ear",
    "right_ear",
    "left_mouth",
    "right_mouth",
    "left_shoulder",  # 11
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_pinky",
    "right_pinky",
    "left_index",
    "right_index",
    "left_thumb",
    "right_thumb",
    "left_hip",  # 23
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
    "left_heel",
    "right_heel",
    "left_foot_index",
    "right_foot_index",  # 32
)


@dataclass(frozen=True)
class MediaPipeWorldLandmark:
    x: float
    y: float
    z: float
    visibility: float | None
    presence: float | None


class MediaPipeLandmarkerBackend(Protocol):
    def __call__(
        self, rgb_frame: NDArray[np.uint8], timestamp_ms: int, /
    ) -> Sequence[MediaPipeWorldLandmark] | None: ...


@contextmanager
def create_mediapipe_tasks_backend(
    model_path: Path,
    *,
    expected_model_hash: str | None = None,
) -> Iterator[MediaPipeLandmarkerBackend]:
    """Open a MediaPipe Tasks VIDEO detector for a single capture clock."""
    model_bytes = model_path.read_bytes()
    if (
        expected_model_hash is not None
        and sha256(model_bytes).hexdigest() != expected_model_hash.lower()
    ):
        raise ValueError("MediaPipe model hash mismatch")
    try:
        mp = importlib.import_module("mediapipe")
    except ImportError as error:
        raise RuntimeError(
            "MediaPipe Tasks requires mediapipe. Run with "
            "uv run --with mediapipe and a Pose Landmarker Full .task model."
        ) from error
    try:
        vision = mp.tasks.vision
        options = vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_buffer=model_bytes),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
        )
        detector = vision.PoseLandmarker.create_from_options(options)
    except (AttributeError, OSError, TypeError, ValueError) as error:
        raise RuntimeError(f"Could not initialize MediaPipe Tasks: {error}") from error

    def detect(
        rgb_frame: NDArray[np.uint8], timestamp_ms: int, /
    ) -> Sequence[MediaPipeWorldLandmark] | None:
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        try:
            poses = detector.detect_for_video(image, timestamp_ms).pose_world_landmarks
        except ValueError as error:
            raise RuntimeError(f"MediaPipe Tasks inference failed: {error}") from error
        if not poses:
            return None
        return [
            MediaPipeWorldLandmark(
                x=point.x,
                y=point.y,
                z=point.z,
                visibility=point.visibility,
                presence=point.presence,
            )
            for point in poses[0]
        ]

    with detector:
        yield detect


def build_mediapipe_plugin_manifest(
    model_path: Path,
    *,
    license_attestation: LicenseAttestation,
    plugin_version: str = PIPELINE_VERSION,
) -> PluginManifest:
    with model_path.open("rb") as stream:
        model_hash = file_digest(stream, "sha256").hexdigest()
    return PluginManifest(
        stage="reconstructor_3d",
        plugin_version=plugin_version,
        contract_compatibility=list(SUPPORTED_CONTRACT_VERSIONS),
        model_hash=model_hash,
        license_tier="A",
        license_attestation=license_attestation,
    )


def _missing(landmark_id: str, reason: MissingReason) -> Landmark3D:
    return Landmark3D(
        landmark_id=landmark_id,
        x=None,
        y=None,
        z=None,
        source="tracker_raw",
        missing_reason=reason,
    )


class MediaPipePoseAdapter:
    """Use an injected detector or open a fresh Tasks detector for each video."""

    def __init__(
        self,
        backend: MediaPipeLandmarkerBackend | Path,
        *,
        min_visibility: float = 0.5,
    ) -> None:
        if not 0 <= min_visibility <= 1:
            raise ValueError("min_visibility must be between 0 and 1")
        self.backend = backend
        self.min_visibility = min_visibility

    def _landmarks(
        self, detected: Sequence[MediaPipeWorldLandmark] | None
    ) -> list[Landmark3D]:
        if detected is None:
            return [
                _missing(name, "occluded")
                for name in (*MEDIAPIPE_LANDMARK_IDS, "pelvis")
            ]
        if len(detected) != len(MEDIAPIPE_LANDMARK_IDS):
            raise RuntimeError("MediaPipe backend must return 33 world landmarks")
        landmarks = []
        for name, point in zip(MEDIAPIPE_LANDMARK_IDS, detected, strict=True):
            if not (
                point.visibility is not None
                and isfinite(point.visibility)
                and point.visibility >= self.min_visibility
                and all(map(isfinite, (point.x, point.y, point.z)))
            ):
                landmarks.append(_missing(name, "low_confidence"))
                continue
            landmarks.append(
                Landmark3D(
                    landmark_id=name,
                    x=point.x,
                    y=-point.y,
                    z=point.z,
                    source="tracker_raw",
                    missing_reason=None,
                )
            )
        left, right = landmarks[23:25]
        if left.missing_reason is None and right.missing_reason is None:
            x, y, z = hip_midpoint(left, right)
            pelvis = Landmark3D(
                landmark_id="pelvis",
                x=x,
                y=y,
                z=z,
                source="tracker_raw",
                missing_reason=None,
            )
        else:
            pelvis = _missing("pelvis", "low_confidence")
        landmarks.append(pelvis)
        return landmarks

    def __call__(
        self,
        observations: Pose2DSequence | None,
        video: Path | None,
        provenance: AnalysisProvenance,
        /,
    ) -> Pose3DSequence:
        if video is None:
            raise ValueError("MediaPipe pose estimation requires a video")
        frames = []
        previous_ms = -1
        backend: AbstractContextManager[MediaPipeLandmarkerBackend]
        if isinstance(self.backend, Path):
            stage = next(
                (
                    model
                    for model in provenance.stage_models
                    if model.stage == "reconstructor_3d"
                ),
                None,
            )
            if stage is None or stage.license_tier != "A":
                raise ValueError("MediaPipe requires Tier A reconstructor provenance")
            backend = create_mediapipe_tasks_backend(
                self.backend, expected_model_hash=stage.model_hash
            )
        else:
            backend = nullcontext(self.backend)
        with backend as detect, closing(iter_video_frames(video)) as decoded:
            for frame in decoded:
                timestamp_ms = round(frame.timestamp_sec * 1000)
                if timestamp_ms <= previous_ms:
                    raise ValueError("video timestamps must increase in milliseconds")
                previous_ms = timestamp_ms
                rgb = np.asarray(
                    cv2.cvtColor(frame.bgr, cv2.COLOR_BGR2RGB), dtype=np.uint8
                )
                frames.append(
                    Frame[Landmark3D](
                        frame_index=frame.frame_index,
                        timestamp_sec=frame.timestamp_sec,
                        landmarks=self._landmarks(detect(rgb, timestamp_ms)),
                    )
                )
        return center_on_hips(
            Pose3DSequence(
                contract_version=provenance.contract_version,
                coordinate_frame="HipRelative3D",
                unit="m",
                is_metric_calibrated=False,
                provenance=provenance,
                frames=frames,
                bone_length_stability_mm=None,
            )
        )
