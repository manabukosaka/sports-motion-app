from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

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
    Stage,
    StereoCalibration,
)
from .filtering import FilterGroup, FilterSettings, filter_pose, interpolate_image
from .interfaces import (
    CoordinateRevisionStage,
    FilterAndKinematicsStage,
    Reconstructor3D,
    Tracker2D,
)
from .kinematics import ARM, calculate_kinematics
from .plugins import LicenseAttestation, PluginManifest, load_plugin_manifest
from .reconstruction import reconstruct
from .revisions import apply_revisions, effective_revisions

CONTRACT_VERSION = "0.1.0"
SUPPORTED_CONTRACT_VERSIONS = (CONTRACT_VERSION, "1.0.0")
PIPELINE_VERSION = "0.1.0"
FILTER_SPEC_VERSION = "0.1.0"
STAGES: tuple[Stage, ...] = (
    "tracker_2d",
    "coordinate_revision",
    "reconstructor_3d",
    "filter_and_kinematics",
)
HIGH_SPEED_LANDMARKS = frozenset(
    (
        *ARM,
        "right_elbow",
        "left_shoulder",
        "left_elbow",
        "left_wrist",
        "left_elbow_left_epicondyle",
        "left_elbow_right_epicondyle",
    )
)


def _filter_and_calculate(
    pose: Pose3DSequence,
    movement: Movement,
    events: Sequence[CaptureEvent],
    analysis_revision_id: str,
    settings: FilterSettings,
) -> tuple[Pose3DSequence, KinematicMetrics, FloatArray, dict[FilterGroup, float]]:
    filtered, cutoffs = filter_pose(pose, HIGH_SPEED_LANDMARKS, settings)
    pose, metrics, angles = calculate_kinematics(
        filtered, movement, events, analysis_revision_id
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
    calibration: DLTCalibration | StereoCalibration
    stage_manifests: tuple[PluginManifest, ...]


def _stage_manifests(
    stages: PipelineStages,
    artifacts: Mapping[Stage, PluginArtifact],
    contract_version: str,
    commercial_default: bool,
) -> tuple[PluginManifest, ...]:
    custom = {
        "tracker_2d": stages.tracker is not None,
        "coordinate_revision": stages.revision is not apply_revisions,
        "reconstructor_3d": stages.reconstruction is not reconstruct,
        "filter_and_kinematics": stages.filter_and_kinematics
        is not _filter_and_calculate,
    }
    manifests = []
    for stage in STAGES:
        artifact = artifacts.get(stage)
        if artifact is not None:
            if not custom[stage] and stage != "tracker_2d":
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
            if custom[stage]:
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
) -> PipelineResult:
    manifests = _stage_manifests(
        stages, artifacts or {}, calibration.contract_version, commercial_default
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
    _, head = effective_revisions(
        history, calibration.contract_version, raw_revision_id
    )
    distinct_views = {view.view_id for view in raw}
    if any(
        edit.view_id not in distinct_views
        for revision in history
        for edit in revision.edits
    ):
        raise ValueError("edit references an unknown view")
    provenance = AnalysisProvenance(
        contract_version=calibration.contract_version,
        pipeline_version=PIPELINE_VERSION,
        stage_models=[manifest.stage_model() for manifest in manifests],
        filter_spec_version=FILTER_SPEC_VERSION,
        calibration_id_or_none=calibration.calibration_id,
        coordinate_revision_id=head if head is not None else raw_revision_id,
    )
    first, second = (
        interpolate_image(
            stages.revision(view.model_copy(deep=True), history),
            filter_settings.max_gap_frames,
        )
        for view in raw
    )
    reconstructed = stages.reconstruction((first, second), calibration, provenance)
    pose, metrics, angles, cutoffs = stages.filter_and_kinematics(
        reconstructed,
        movement,
        events,
        analysis_revision_id,
        filter_settings,
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
