import re
from datetime import datetime
from itertools import pairwise
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

SEMVER = (
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
SemVer = Annotated[str, StringConstraints(pattern=re.compile(rf"\A{SEMVER}\Z"))]
ModelHash = Annotated[
    str, StringConstraints(pattern=re.compile(r"\A(?:[0-9A-Fa-f]{64}|none)\Z"))
]
NonBlank = Annotated[str, StringConstraints(pattern=r"\S")]
NonNegative = Annotated[float, Field(ge=0)]
Positive = Annotated[float, Field(gt=0)]
Fraction = Annotated[float, Field(ge=0, le=1)]
FrameIndex = Annotated[int, Field(ge=0)]
Vector3 = Annotated[list[float], Field(min_length=3, max_length=3)]
Matrix3 = Annotated[list[Vector3], Field(min_length=3, max_length=3)]
Stage = Literal[
    "tracker_2d", "coordinate_revision", "reconstructor_3d", "filter_and_kinematics"
]
LicenseTier = Literal["A", "B", "C"]
ObservationSource = Literal["tracker_raw", "manual_edit", "spline_interpolated"]
MissingReason = Literal[
    "occluded",
    "low_confidence",
    "out_of_frame",
    "unidentifiable_axis",
    "insufficient_calibration",
]
Movement = Literal["baseball_pitching", "running", "cmj", "dvj"]
Side = Literal["left", "right"]
Plane = Literal[
    "sagittal", "frontal", "transverse", "local_axis", "vertical_axis", "temporal"
]
Unit = Literal[
    "deg",
    "rad",
    "deg_per_s",
    "rad_per_s",
    "m",
    "mm",
    "px",
    "m_per_s",
    "spm",
    "dimensionless",
]
ComparisonUnit = Literal["deg", "deg_per_s", "m", "m_per_s", "spm", "dimensionless"]
IntervalID = Literal[
    "pitch_cycle", "run_stride", "run_stance", "cmj_cycle", "dvj_cycle"
]
CaptureEventID = Literal[
    "pitch_leg_lift",
    "pitch_foot_contact",
    "pitch_mer",
    "pitch_ball_release",
    "pitch_mir",
    "run_initial_contact",
    "run_mid_stance",
    "run_toe_off",
    "run_next_initial_contact",
    "cmj_initiation",
    "cmj_peak_flexion",
    "cmj_takeoff",
    "cmj_initial_landing_contact",
    "cmj_peak_landing_flexion",
    "dvj_initial_landing_contact",
    "dvj_peak_landing_flexion",
    "dvj_takeoff",
    "dvj_rebound_landing_contact",
]
EventID = CaptureEventID | IntervalID
MetricID = Literal[
    "pitch_pelvis_rotation_angle",
    "pitch_thorax_rotation_angle",
    "pitch_pelvis_peak_rotation_angular_velocity",
    "pitch_thorax_peak_rotation_angular_velocity",
    "pitch_pelvis_peak_rotation_timing",
    "pitch_thorax_peak_rotation_timing",
    "pitch_shoulder_axial_rotation_angle",
    "pitch_shoulder_peak_internal_rotation_angular_velocity",
    "pitch_elbow_flexion_angle",
    "pitch_elbow_peak_extension_angular_velocity",
    "run_hip_flexion_extension_angle",
    "run_knee_flexion_extension_angle",
    "run_ankle_dorsiflexion_plantarflexion_angle",
    "run_pelvic_obliquity_angle",
    "run_hip_adduction_angle",
    "run_stride_length",
    "run_mean_forward_speed",
    "run_cadence",
    "jump_landing_hip_flexion_angle",
    "jump_landing_knee_flexion_angle",
    "jump_landing_ankle_dorsiflexion_angle",
    "jump_landing_knee_abduction_angle",
    "jump_com_rise",
    "jump_takeoff_vertical_com_velocity",
]


class Contract(BaseModel):
    model_config = ConfigDict(
        strict=True, extra="forbid", allow_inf_nan=False, frozen=True
    )


def _boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError("expected a boolean")
    return value


StrictTrue = Annotated[Literal[True], BeforeValidator(_boolean)]
StrictFalse = Annotated[Literal[False], BeforeValidator(_boolean)]


class StageModel(Contract):
    stage: Stage
    model_hash: ModelHash
    license_tier: LicenseTier


class AnalysisProvenance(Contract):
    contract_version: SemVer
    pipeline_version: SemVer
    stage_models: Annotated[list[StageModel], Field(min_length=1)]
    filter_spec_version: SemVer
    calibration_id_or_none: NonBlank
    coordinate_revision_id: NonBlank

    @property
    def calibration_id(self) -> str | None:
        return (
            None
            if self.calibration_id_or_none == "none"
            else self.calibration_id_or_none
        )


class Landmark(Contract):
    landmark_id: NonBlank
    x: float | None
    y: float | None
    source: ObservationSource
    missing_reason: MissingReason | None

    def axes(self) -> tuple[float | None, ...]:
        return self.x, self.y

    @model_validator(mode="after")
    def validate_missing(self) -> Self:
        if any(
            (value is None) != (self.missing_reason is not None)
            for value in self.axes()
        ):
            raise ValueError(
                "all axes must be present exactly when missing_reason is null"
            )
        return self


class Landmark2D(Landmark):
    confidence: Fraction | None


class Landmark3D(Landmark):
    z: float | None

    def axes(self) -> tuple[float | None, ...]:
        return self.x, self.y, self.z


class Frame[L: Landmark](Contract):
    frame_index: FrameIndex
    timestamp_sec: NonNegative
    landmarks: list[L]


class TimedSequence[L: Landmark](Contract):
    contract_version: SemVer
    frames: Annotated[list[Frame[L]], Field(min_length=1)]

    @model_validator(mode="after")
    def validate_order(self) -> Self:
        for previous, current in pairwise(self.frames):
            if (
                previous.frame_index >= current.frame_index
                or previous.timestamp_sec >= current.timestamp_sec
            ):
                raise ValueError("frame_index and timestamp_sec must strictly increase")
        return self


class Pose2DSequence(TimedSequence[Landmark2D]):
    trial_id: NonBlank
    view_id: NonBlank
    fps: Positive
    width_px: Annotated[int, Field(gt=0)]
    height_px: Annotated[int, Field(gt=0)]
    lens_undistorted: bool
    coordinate_frame: Literal["Image2D"]
    unit: Literal["px"]


class CoordinateEdit(Contract):
    view_id: NonBlank
    frame_index: FrameIndex
    landmark: Landmark2D


class CoordinateRevision(Contract):
    contract_version: SemVer
    revision_id: NonBlank
    expected_head: NonBlank | None
    parent_revision_id: NonBlank | None
    operation: Literal["edit", "undo", "redo"]
    edits: list[CoordinateEdit]

    @model_validator(mode="after")
    def validate_operation(self) -> Self:
        if self.operation == "edit":
            if not self.edits:
                raise ValueError("edit requires coordinates")
        elif (
            self.edits or self.expected_head is None or self.parent_revision_id is None
        ):
            raise ValueError("undo and redo require a parent and empty edits")
        return self


class Pose3DSequence(TimedSequence[Landmark3D]):
    coordinate_frame: Literal["CalibratedWorld3D", "HipRelative3D"]
    unit: Literal["m"]
    is_metric_calibrated: bool
    provenance: AnalysisProvenance
    bone_length_stability_mm: NonNegative | None

    @model_validator(mode="after")
    def validate_frame(self) -> Self:
        if self.is_metric_calibrated != (self.coordinate_frame == "CalibratedWorld3D"):
            raise ValueError("coordinate frame and calibration flag disagree")
        if self.is_metric_calibrated and self.provenance.calibration_id is None:
            raise ValueError("metric coordinates require a calibration ID")
        return self


class Intrinsics(Contract):
    fx_px: Positive
    fy_px: Positive
    cx_px: float
    cy_px: float


class StereoView(Contract):
    view_id: NonBlank
    intrinsics: Intrinsics
    distortion_coefficients: Annotated[list[float], Field(min_length=5, max_length=5)]


class DLTView(StereoView):
    dlt_params: Annotated[list[float], Field(min_length=11, max_length=11)]


class StereoCheck(Contract):
    reprojection_error_px: NonNegative


class DLTCheck(StereoCheck):
    known_distance_rmse_m: NonNegative


class Calibration(Contract):
    contract_version: SemVer
    calibration_id: NonBlank

    @model_validator(mode="after")
    def validate_id(self) -> Self:
        if self.calibration_id == "none":
            raise ValueError("calibration ID cannot be 'none'")
        return self


class MonocularReferenceCalibration(Calibration):
    mode: Literal["monocular_reference"]
    view_id: NonBlank


MonocularCalibration = MonocularReferenceCalibration


class TwoViewCalibration[V: StereoView](Calibration):
    views: Annotated[list[V], Field(min_length=2, max_length=2)]

    @model_validator(mode="after")
    def validate_views(self) -> Self:
        if self.views[0].view_id == self.views[1].view_id:
            raise ValueError("calibration views must be distinct")
        return self


class DLTCalibration(TwoViewCalibration[DLTView]):
    mode: Literal["dlt_control_poles"]
    held_out_check: DLTCheck


class StereoCalibration(TwoViewCalibration[StereoView]):
    mode: Literal["stereo_checkerboard_charuco"]
    rotation_matrix: Matrix3
    translation_m: Vector3
    fit_rms_px: NonNegative
    held_out_check: StereoCheck


CalibrationParams = Annotated[
    MonocularCalibration | DLTCalibration | StereoCalibration,
    Field(discriminator="mode"),
]


class Sided(Contract):
    side: Side | None = Field(default=None, exclude_if=lambda side: side is None)

    @model_validator(mode="after")
    def validate_side(self) -> Self:
        if self.side is None and "side" in self.model_fields_set:
            raise ValueError("side must be left or right when supplied")
        return self


class CaptureEvent(Sided):
    event_id: CaptureEventID
    frame_index: FrameIndex
    timestamp_sec: NonNegative
    detection_mode: Literal["automatic", "manual"]


class ScalarMetric(Sided):
    metric_id: MetricID
    event_id: EventID
    value_or_null: float | None
    unit: Unit
    anatomical_plane: Plane
    missing_reason_or_null: MissingReason | None

    @model_validator(mode="after")
    def validate_missing(self) -> Self:
        if (self.value_or_null is None) == (self.missing_reason_or_null is None):
            raise ValueError(
                "a metric requires either a measured value or a missing reason"
            )
        return self


class NormalizedPoint(Contract):
    normalized_time_fraction: Fraction
    value: float


class NormalizedWaveform(Sided):
    metric_id: MetricID
    interval_id: IntervalID
    unit: Unit
    anatomical_plane: Plane
    points: Annotated[list[NormalizedPoint], Field(min_length=2)]


class KinematicMetrics(Contract):
    contract_version: SemVer
    analysis_revision_id: NonBlank
    movement_type: Movement
    provenance: AnalysisProvenance
    events: list[CaptureEvent]
    scalar_metrics: list[ScalarMetric]
    normalized_waveforms: list[NormalizedWaveform]


class MeanSD(Contract):
    mean: float
    sd: NonNegative


class MedianIQR(Contract):
    median: float
    q1: float
    q3: float


class ThresholdRange(Contract):
    lower: float
    upper: float


class EvidenceComparison(Sided):
    metric_id: MetricID
    event_id: EventID
    unit: ComparisonUnit
    anatomical_plane: Plane
    source_doi: Annotated[str, StringConstraints(pattern=r"^10\.\d{4,9}/\S+$")]
    source_locator: NonBlank
    source_authors: Annotated[list[NonBlank], Field(min_length=1)]
    source_year: Annotated[int, Field(ge=1980)]
    source_journal: NonBlank
    measurement_modality: Literal[
        "optical_mocap",
        "markerless_smartphone",
        "video_2d",
        "systematic_review",
        "standard_guideline",
    ]
    cohort_notes: NonBlank
    sample_size: Annotated[int, Field(ge=1)]
    observed_value: float


class MeanComparison(EvidenceComparison):
    stat_type: Literal["mean_sd"]
    reference_values: MeanSD


class MedianComparison(EvidenceComparison):
    stat_type: Literal["median_iqr"]
    reference_values: MedianIQR


class ThresholdComparison(EvidenceComparison):
    stat_type: Literal["threshold_range"]
    reference_values: ThresholdRange


DateTimeString = Annotated[
    str,
    StringConstraints(
        pattern=re.compile(
            r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
            r"(?:\.(?P<fraction>[0-9]+))?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])\Z",
            re.IGNORECASE,
        )
    ),
]
Comparison = Annotated[
    MeanComparison | MedianComparison | ThresholdComparison,
    Field(discriminator="stat_type"),
]


def _timestamp_key(value: str) -> tuple[datetime, str]:
    fraction = value.partition(".")[2]
    fraction = re.split("[Zz+-]", fraction, maxsplit=1)[0]
    return datetime.fromisoformat(value.upper()), fraction.rstrip("0")


class ShareReportSnapshot(Contract):
    contract_version: SemVer
    share_link_id: NonBlank
    team_id: NonBlank
    analysis_revision_id: NonBlank
    evidence_snapshot_id: NonBlank
    evidence_registry_version: SemVer
    issued_at: DateTimeString
    expires_at: DateTimeString
    non_diagnostic_flag: StrictTrue
    disclaimer_text_ja: NonBlank
    kinematic_summary: KinematicMetrics
    evidence_comparisons: list[Comparison]

    @model_validator(mode="after")
    def validate_snapshot(self) -> Self:
        if self.analysis_revision_id != self.kinematic_summary.analysis_revision_id:
            raise ValueError(
                "share and metrics must reference the same analysis revision"
            )
        if _timestamp_key(self.expires_at) <= _timestamp_key(self.issued_at):
            raise ValueError("expiry must be after issue time")
        return self
