from collections.abc import Sequence
from pathlib import Path
from typing import Protocol

from .calibration import FloatArray
from .contracts import (
    AnalysisProvenance,
    CaptureEvent,
    CoordinateRevision,
    DLTCalibration,
    KinematicMetrics,
    Movement,
    Pose2DSequence,
    Pose3DSequence,
    StereoCalibration,
)
from .filtering import FilterGroup, FilterSettings


class Tracker2D(Protocol):
    def __call__(self, video: Path, /) -> Pose2DSequence: ...


class Monocular3DEstimator(Protocol):
    def __call__(
        self,
        observations: Pose2DSequence | None,
        video: Path | None,
        provenance: AnalysisProvenance,
        /,
    ) -> Pose3DSequence:
        """Return hip-relative estimates on the capture clock.

        Video models can decode frames with iter_video_frames. Revised Image2D
        observations are supplied when available. Mark model-derived points as
        tracker_raw when an Image2D edit did not change the predicted 3D point.
        """
        ...


class CoordinateRevisionStage(Protocol):
    def __call__(
        self, raw: Pose2DSequence, revisions: list[CoordinateRevision], /
    ) -> Pose2DSequence: ...


class Reconstructor3D(Protocol):
    def __call__(
        self,
        observations: tuple[Pose2DSequence, Pose2DSequence],
        calibration: DLTCalibration | StereoCalibration,
        provenance: AnalysisProvenance,
        /,
    ) -> Pose3DSequence: ...


class FilterAndKinematicsStage(Protocol):
    def __call__(
        self,
        pose: Pose3DSequence,
        movement: Movement,
        events: Sequence[CaptureEvent],
        analysis_revision_id: str,
        settings: FilterSettings,
        /,
    ) -> tuple[
        Pose3DSequence, KinematicMetrics, FloatArray, dict[FilterGroup, float]
    ]: ...
