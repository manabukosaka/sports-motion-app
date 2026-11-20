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
