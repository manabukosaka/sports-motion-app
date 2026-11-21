from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isclose
from pathlib import Path

from .calibration import FloatArray
from .contracts import (
    AnalysisProvenance,
    CaptureEvent,
    CoordinateRevision,
    DLTCalibration,
    KinematicMetrics,
    MonocularCalibration,
    Movement,
    Pose2DSequence,
    Pose3DSequence,
    Stage,
    StereoCalibration,
)
from .filtering import FilterGroup, FilterSettings, filter_pose, interpolate_image
from .interfaces import (
    CoordinateRevisionStage,
    FilterAndKinematicsStage,
    Monocular3DEstimator,
    Reconstructor3D,
    Tracker2D,
)
from .kinematics import calculate_kinematics
from .monocular import center_on_hips, lift_geometric, read_video_metadata
from .plugins import LicenseAttestation, PluginManifest, load_plugin_manifest
from .reconstruction import reconstruct
from .revisions import apply_revisions, effective_revisions

CONTRACT_VERSION = "0.1.0"
SUPPORTED_CONTRACT_VERSIONS = (CONTRACT_VERSION, "1.0.0")
PIPELINE_VERSION = "0.2.0"
FILTER_SPEC_VERSION = "0.2.0"
STAGES: tuple[Stage, ...] = (
    "tracker_2d",
    "coordinate_revision",
    "reconstructor_3d",
    "filter_and_kinematics",
)
HIGH_SPEED_LANDMARKS = frozenset(
    f"{side}_{name}"
    for side in ("left", "right")
    for name in (
        "shoulder",
        "elbow",
        "wrist",
        "elbow_left_epicondyle",
        "elbow_right_epicondyle",
    )
)


def _filter_and_calculate(
    pose: Pose3DSequence,
    movement: Movement,
    events: Sequence[CaptureEvent],
    analysis_revision_id: str,
    settings: FilterSettings,
    *,
    world_basis: FloatArray | None = None,
    projected: bool = False,
) -> tuple[Pose3DSequence, KinematicMetrics, FloatArray, dict[FilterGroup, float]]:
    filtered, cutoffs = filter_pose(pose, HIGH_SPEED_LANDMARKS, settings)
    if filtered.coordinate_frame == "HipRelative3D":
        filtered = center_on_hips(filtered)
    pose, metrics, angles = calculate_kinematics(
        filtered,
        movement,
        events,
        analysis_revision_id,
        world_basis=world_basis,
        projected=projected,
    )
    return pose, metrics, angles, cutoffs


@dataclass(frozen=True)
class PipelineStages:
    tracker: Tracker2D | None = None
    revision: CoordinateRevisionStage = apply_revisions
    reconstruction: Reconstructor3D = reconstruct
    filter_and_kinematics: FilterAndKinematicsStage = _filter_and_calculate


@dataclass(frozen=True)
class PluginArtifact:
    manifest_path: Path
    model_path: Path | None = None
    expected_plugin_version: str | None = None


@dataclass(frozen=True)
class PipelineResult:
    pose: Pose3DSequence
    metrics: KinematicMetrics
    angle_series_deg: FloatArray
    selected_cutoffs_hz: dict[FilterGroup, float]
    filter_settings: FilterSettings
    calibration: DLTCalibration | StereoCalibration | MonocularCalibration
    stage_manifests: tuple[PluginManifest, ...]


def _stage_manifests(
    custom: set[Stage],
    artifacts: Mapping[Stage, PluginArtifact],
    contract_version: str,
    commercial_default: bool,
) -> tuple[PluginManifest, ...]:
    manifests = []
    for stage in STAGES:
        artifact = artifacts.get(stage)
        if artifact is not None:
            if stage not in custom and stage != "tracker_2d":
                raise ValueError(
                    f"{stage} manifest does not match the configured stage"
                )
            manifest = load_plugin_manifest(
                artifact.manifest_path,
                expected_stage=stage,
                contract_version=contract_version,
                model_path=artifact.model_path,
                expected_plugin_version=artifact.expected_plugin_version,
                commercial_default=commercial_default,
            )
        else:
            if stage in custom:
                raise ValueError(f"{stage} requires a plugin manifest")
            if contract_version not in SUPPORTED_CONTRACT_VERSIONS:
                raise ValueError(
                    f"{stage} does not support contract version {contract_version}"
                )
            manifest = PluginManifest(
                stage=stage,
                plugin_version=PIPELINE_VERSION,
                contract_compatibility=list(SUPPORTED_CONTRACT_VERSIONS),
                model_hash="none",
                license_tier="A",
                license_attestation=LicenseAttestation(
                    attested_by="sports-motion-app",
                    rights_evidence="first-party motion-engine stage",
                    intended_use="commercial default",
                ),
            )
        manifests.append(manifest)
    return tuple(manifests)


def _provenance(
    contract_version: str,
    calibration_id: str,
    raw_revision_id: str,
    history: list[CoordinateRevision],
    views: set[str],
    manifests: tuple[PluginManifest, ...],
) -> AnalysisProvenance:
    _, head = effective_revisions(history, contract_version, raw_revision_id)
    if any(
        edit.view_id not in views for revision in history for edit in revision.edits
    ):
        raise ValueError("edit references an unknown view")
    return AnalysisProvenance(
        contract_version=contract_version,
        pipeline_version=PIPELINE_VERSION,
        stage_models=[manifest.stage_model() for manifest in manifests],
        filter_spec_version=FILTER_SPEC_VERSION,
        calibration_id_or_none=calibration_id,
        coordinate_revision_id=head if head is not None else raw_revision_id,
    )


def run_calibrated_pipeline(
    inputs: tuple[Pose2DSequence, Pose2DSequence] | tuple[Path, Path],
    calibration: DLTCalibration | StereoCalibration,
    *,
    movement: Movement,
    analysis_revision_id: str,
    raw_revision_id: str,
    revisions: Sequence[CoordinateRevision] = (),
    events: Sequence[CaptureEvent] = (),
    filter_settings: FilterSettings = FilterSettings(),
    stages: PipelineStages = PipelineStages(),
    artifacts: Mapping[Stage, PluginArtifact] | None = None,
    commercial_default: bool = True,
    world_basis: FloatArray | None = None,
) -> PipelineResult:
    """Run the two-view pipeline.

    Supply the lab basis in the reconstructed world coordinates to enable
    forward and vertical metrics. For stereo, this is the first camera's frame.
    """
    if not isinstance(calibration, (DLTCalibration, StereoCalibration)):
        raise TypeError("calibrated analysis requires a two-view calibration")
    configured: dict[Stage, bool] = {
        "tracker_2d": stages.tracker is not None,
        "coordinate_revision": stages.revision is not apply_revisions,
        "reconstructor_3d": stages.reconstruction is not reconstruct,
        "filter_and_kinematics": stages.filter_and_kinematics
        is not _filter_and_calculate,
    }
    manifests = _stage_manifests(
        {stage for stage, is_custom in configured.items() if is_custom},
        artifacts or {},
        calibration.contract_version,
        commercial_default,
    )
    left, right = inputs
    if (
        isinstance(left, Path)
        and isinstance(right, Path)
        and stages.tracker is not None
    ):
        raw = stages.tracker(left), stages.tracker(right)
    elif (
        isinstance(left, Pose2DSequence)
        and isinstance(right, Pose2DSequence)
        and stages.tracker is None
    ):
        raw = left, right
    else:
        raise ValueError(
            "provide two raw observations or two videos with a configured tracker"
        )
    if any(view.contract_version != calibration.contract_version for view in raw):
        raise ValueError(
            "raw observations and calibration must share a contract version"
        )
    history = list(revisions)
    provenance = _provenance(
        calibration.contract_version,
        calibration.calibration_id,
        raw_revision_id,
        history,
        {view.view_id for view in raw},
        manifests,
    )
    first, second = (
        interpolate_image(
            stages.revision(view.model_copy(deep=True), history),
            filter_settings.max_gap_frames,
        )
        for view in raw
    )
    reconstructed = stages.reconstruction((first, second), calibration, provenance)
    if (
        reconstructed.coordinate_frame != "CalibratedWorld3D"
        or not reconstructed.is_metric_calibrated
    ):
        raise TypeError(
            "calibrated reconstruction requires calibrated world coordinates"
        )
    if stages.filter_and_kinematics is _filter_and_calculate:
        pose, metrics, angles, cutoffs = _filter_and_calculate(
            reconstructed,
            movement,
            events,
            analysis_revision_id,
            filter_settings,
            world_basis=world_basis,
        )
    else:
        pose, metrics, angles, cutoffs = stages.filter_and_kinematics(
            reconstructed, movement, events, analysis_revision_id, filter_settings
        )
    if (
        pose.provenance != provenance
        or metrics.provenance != provenance
        or not pose.is_metric_calibrated
        or pose.contract_version != provenance.contract_version
        or metrics.contract_version != provenance.contract_version
        or metrics.analysis_revision_id != analysis_revision_id
        or metrics.movement_type != movement
    ):
        raise RuntimeError(
            "pipeline output does not match the calibrated analysis context"
        )
    return PipelineResult(
        pose, metrics, angles, cutoffs, filter_settings, calibration, manifests
    )


def run_monocular_pipeline(
    source: Pose2DSequence | Path,
    calibration: MonocularCalibration,
    *,
    movement: Movement,
    analysis_revision_id: str,
    raw_revision_id: str,
    revisions: Sequence[CoordinateRevision] = (),
    events: Sequence[CaptureEvent] = (),
    filter_settings: FilterSettings = FilterSettings(),
    tracker: Tracker2D | None = None,
    estimator: Monocular3DEstimator = lift_geometric,
    artifacts: Mapping[Stage, PluginArtifact] | None = None,
) -> PipelineResult:
    if not isinstance(calibration, MonocularCalibration):
        raise TypeError("monocular analysis requires a reference view")
    custom: set[Stage] = set()
    if tracker is not None:
        custom.add("tracker_2d")
    if estimator is not lift_geometric:
        custom.add("reconstructor_3d")
    manifests = _stage_manifests(
        custom, artifacts or {}, calibration.contract_version, commercial_default=True
    )
    video = source if isinstance(source, Path) else None
    metadata = read_video_metadata(video) if video is not None else None
    raw: Pose2DSequence | None
    if isinstance(source, Path):
        raw = tracker(source) if tracker is not None else None
    elif tracker is None:
        raw = source
    else:
        raise ValueError("a tracker requires a video path")
    if raw is None and revisions:
        raise ValueError(
            "coordinate revisions require Image2D observations or a tracker"
        )
    if raw is not None and (
        raw.view_id != calibration.view_id
        or raw.contract_version != calibration.contract_version
    ):
        raise ValueError(
            "monocular observations must match the reference view and contract"
        )
    if (
        raw is not None
        and metadata is not None
        and (
            (raw.width_px, raw.height_px) != (metadata.width_px, metadata.height_px)
            or not isclose(raw.fps, metadata.fps, rel_tol=1e-3)
            or raw.frames[-1].frame_index >= metadata.frame_count
        )
    ):
        raise ValueError("tracker observations do not match the source video")
    history = list(revisions)
    provenance = _provenance(
        calibration.contract_version,
        "none",
        raw_revision_id,
        history,
        {calibration.view_id},
        manifests,
    )
    observations = (
        interpolate_image(apply_revisions(raw, history), filter_settings.max_gap_frames)
        if raw is not None
        else None
    )
    reconstructed = estimator(observations, video, provenance)
    if (
        reconstructed.coordinate_frame != "HipRelative3D"
        or reconstructed.is_metric_calibrated
    ):
        raise TypeError(
            "monocular estimation requires uncalibrated hip-relative coordinates"
        )
    if (
        reconstructed.provenance != provenance
        or reconstructed.contract_version != calibration.contract_version
    ):
        raise ValueError(
            "monocular estimator output does not match the analysis provenance"
        )
    if (
        metadata is not None
        and reconstructed.frames[-1].frame_index >= metadata.frame_count
    ):
        raise ValueError("monocular estimator returned frames outside the source video")
    clock = [(frame.frame_index, frame.timestamp_sec) for frame in reconstructed.frames]
    if observations is not None and clock != [
        (frame.frame_index, frame.timestamp_sec) for frame in observations.frames
    ]:
        raise ValueError("monocular estimator must preserve the observation clock")
    pose, metrics, angles, cutoffs = _filter_and_calculate(
        reconstructed if estimator is lift_geometric else center_on_hips(reconstructed),
        movement,
        events,
        analysis_revision_id,
        filter_settings,
        projected=estimator is lift_geometric,
    )
    return PipelineResult(
        pose, metrics, angles, cutoffs, filter_settings, calibration, manifests
    )
