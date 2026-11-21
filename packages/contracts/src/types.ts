import type { FrameIndex, Meters, Millimeters, Pixels, Seconds, ViewId } from "./units.js";

type MissingReason =
  | "occluded"
  | "low_confidence"
  | "out_of_frame"
  | "unidentifiable_axis"
  | "insufficient_calibration";
type Unit =
  | "deg"
  | "rad"
  | "deg_per_s"
  | "rad_per_s"
  | "m"
  | "mm"
  | "px"
  | "m_per_s"
  | "spm"
  | "dimensionless";
type EvidenceUnit = Extract<Unit, "deg" | "deg_per_s" | "m" | "m_per_s" | "spm" | "dimensionless">;
type AnatomicalPlane =
  | "sagittal"
  | "frontal"
  | "transverse"
  | "local_axis"
  | "vertical_axis"
  | "temporal";
type MeasurementModality =
  | "optical_mocap"
  | "markerless_smartphone"
  | "video_2d"
  | "systematic_review"
  | "standard_guideline";

type MetricId =
  | "pitch_pelvis_rotation_angle"
  | "pitch_thorax_rotation_angle"
  | "pitch_pelvis_peak_rotation_angular_velocity"
  | "pitch_thorax_peak_rotation_angular_velocity"
  | "pitch_pelvis_peak_rotation_timing"
  | "pitch_thorax_peak_rotation_timing"
  | "pitch_shoulder_axial_rotation_angle"
  | "pitch_shoulder_peak_internal_rotation_angular_velocity"
  | "pitch_elbow_flexion_angle"
  | "pitch_elbow_peak_extension_angular_velocity"
  | "run_hip_flexion_extension_angle"
  | "run_knee_flexion_extension_angle"
  | "run_ankle_dorsiflexion_plantarflexion_angle"
  | "run_pelvic_obliquity_angle"
  | "run_hip_adduction_angle"
  | "run_stride_length"
  | "run_mean_forward_speed"
  | "run_cadence"
  | "jump_landing_hip_flexion_angle"
  | "jump_landing_knee_flexion_angle"
  | "jump_landing_ankle_flexion_angle"
  | "jump_landing_knee_abduction_angle"
  | "jump_com_rise"
  | "jump_takeoff_vertical_com_velocity";
type IntervalId = "pitch_cycle" | "run_stride" | "run_stance" | "cmj_cycle" | "dvj_cycle";
type DiscreteEventId =
  | "pitch_leg_lift"
  | "pitch_foot_contact"
  | "pitch_mer"
  | "pitch_ball_release"
  | "pitch_mir"
  | "run_initial_contact"
  | "run_mid_stance"
  | "run_toe_off"
  | "run_next_initial_contact"
  | "cmj_initiation"
  | "cmj_peak_flexion"
  | "cmj_takeoff"
  | "cmj_initial_landing_contact"
  | "cmj_peak_landing_flexion"
  | "dvj_initial_landing_contact"
  | "dvj_peak_landing_flexion"
  | "dvj_takeoff"
  | "dvj_rebound_landing_contact";
type EventId = DiscreteEventId | IntervalId;
type NonEmpty<T> = [T, ...T[]];

interface VersionedContract {
  contract_version: string;
}

interface AnalysisProvenance extends VersionedContract {
  pipeline_version: string;
  stage_models: NonEmpty<{
    stage: "tracker_2d" | "coordinate_revision" | "reconstructor_3d" | "filter_and_kinematics";
    model_hash: string;
    license_tier: "A" | "B" | "C";
  }>;
  filter_spec_version: string;
  calibration_id_or_none: string;
  coordinate_revision_id: string;
}

interface Observation {
  landmark_id: string;
  source: "tracker_raw" | "manual_edit" | "spline_interpolated";
}

type Observation2D = Observation & {
  confidence: number | null;
} & (
    | { missing_reason: null; x: Pixels; y: Pixels }
    | { missing_reason: MissingReason; x: null; y: null }
  );
type Observation3D = Observation &
  (
    | { missing_reason: null; x: Meters; y: Meters; z: Meters }
    | { missing_reason: MissingReason; x: null; y: null; z: null }
  );

interface PoseFrame<Landmark> {
  frame_index: FrameIndex;
  timestamp_sec: Seconds;
  landmarks: Landmark[];
}

export interface Pose2DSequence extends VersionedContract {
  trial_id: string;
  view_id: ViewId;
  fps: number;
  width_px: Pixels;
  height_px: Pixels;
  lens_undistorted: boolean;
  coordinate_frame: "Image2D";
  unit: "px";
  frames: NonEmpty<PoseFrame<Observation2D>>;
}

interface CoordinateEdit {
  view_id: ViewId;
  frame_index: FrameIndex;
  landmark: Observation2D;
}
interface RevisionBase extends VersionedContract {
  revision_id: string;
}
export type CoordinateRevision = RevisionBase &
  (
    | {
        operation: "edit";
        expected_head: string | null;
        parent_revision_id: string | null;
        edits: NonEmpty<CoordinateEdit>;
      }
    | { operation: "undo" | "redo"; expected_head: string; parent_revision_id: string; edits: [] }
  );

interface CalibrationBase extends VersionedContract {
  calibration_id: string;
}
interface CalibrationView {
  view_id: ViewId;
  intrinsics: { fx_px: Pixels; fy_px: Pixels; cx_px: Pixels; cy_px: Pixels };
  distortion_coefficients: [number, number, number, number, number];
}
interface DltView extends CalibrationView {
  dlt_params: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
}
type Vector3<T> = [T, T, T];

export type CalibrationParams = CalibrationBase &
  (
    | { mode: "monocular_reference"; view_id: ViewId }
    | {
        mode: "dlt_control_poles";
        views: [DltView, DltView];
        held_out_check: { reprojection_error_px: Pixels; known_distance_rmse_m: Meters };
      }
    | {
        mode: "stereo_checkerboard_charuco";
        views: [CalibrationView, CalibrationView];
        rotation_matrix: Vector3<Vector3<number>>;
        translation_m: Vector3<Meters>;
        fit_rms_px: Pixels;
        held_out_check: { reprojection_error_px: Pixels };
      }
  );

interface Pose3DBase extends VersionedContract {
  unit: "m";
  provenance: AnalysisProvenance;
  frames: NonEmpty<PoseFrame<Observation3D>>;
  bone_length_stability_mm: Millimeters | null;
}
export type Pose3DSequence = Pose3DBase &
  (
    | { coordinate_frame: "CalibratedWorld3D"; is_metric_calibrated: true }
    | { coordinate_frame: "HipRelative3D"; is_metric_calibrated: false }
  );

interface KinematicEvent {
  event_id: DiscreteEventId;
  frame_index: FrameIndex;
  timestamp_sec: Seconds;
  detection_mode: "automatic" | "manual";
  side?: "left" | "right";
}
interface MetricDescription {
  metric_id: MetricId;
  unit: Unit;
  anatomical_plane: AnatomicalPlane;
  side?: "left" | "right";
}
type ScalarMetric = MetricDescription & { event_id: EventId } & (
    | { value_or_null: number; missing_reason_or_null: null }
    | { value_or_null: null; missing_reason_or_null: MissingReason }
  );
interface WaveformPoint {
  normalized_time_fraction: number;
  value: number;
}
interface NormalizedWaveform extends MetricDescription {
  interval_id: IntervalId;
  points: [WaveformPoint, WaveformPoint, ...WaveformPoint[]];
}

export interface KinematicMetrics extends VersionedContract {
  analysis_revision_id: string;
  movement_type: "baseball_pitching" | "running" | "cmj" | "dvj";
  provenance: AnalysisProvenance;
  events: KinematicEvent[];
  scalar_metrics: ScalarMetric[];
  normalized_waveforms: NormalizedWaveform[];
}

interface StatisticValues {
  mean_sd: { mean: number; sd: number };
  median_iqr: { median: number; q1: number; q3: number };
  threshold_range: { lower: number; upper: number };
}
type Statistic<ValuesField extends string> = {
  [Kind in keyof StatisticValues]: { stat_type: Kind } & Record<ValuesField, StatisticValues[Kind]>;
}[keyof StatisticValues];

type EvidenceComparison = MetricDescription & {
  event_id: EventId;
  unit: EvidenceUnit;
  source_doi: string;
  source_locator: string;
  source_authors: NonEmpty<string>;
  source_year: number;
  source_journal: string;
  measurement_modality: MeasurementModality;
  cohort_notes: string;
  sample_size: number;
  observed_value: number;
} & Statistic<"reference_values">;

export interface ShareReportSnapshot extends VersionedContract {
  share_link_id: string;
  team_id: string;
  analysis_revision_id: string;
  evidence_snapshot_id: string;
  evidence_registry_version: string;
  issued_at: string;
  expires_at: string;
  non_diagnostic_flag: true;
  disclaimer_text_ja: string;
  kinematic_summary: KinematicMetrics;
  evidence_comparisons: EvidenceComparison[];
}

interface Study {
  id: string;
  domain: "baseball_pitching" | "running" | "jump_landing" | "standard_method";
  authors: NonEmpty<string>;
  year: number;
  journal: string;
  title: string;
  doi: string;
  measurement_modality: MeasurementModality;
  population_notes: string;
  metrics_covered: MetricId[];
  extraction_status: "cataloged_pending_fulltext" | "verified_normative";
  comparability_bias_note: string;
}
type NormativeMetric = {
  metric_id: MetricId;
  unit: EvidenceUnit;
  anatomical_plane: AnatomicalPlane;
  source_doi: string;
  non_diagnostic_flag: true;
} & (
  | { event_id: EventId; normalized_time_fraction?: never }
  | { event_id: IntervalId; normalized_time_fraction: number }
) &
  (
    | {
        status: "pending_fulltext_extraction";
        stat_type: keyof StatisticValues;
        sample_size: null;
        source_locator: null;
        cohort_notes: null;
        values: null;
      }
    | ({
        status: "verified_normative";
        sample_size: number;
        source_locator: string;
        cohort_notes: string;
      } & Statistic<"values">)
  );

export interface EvidenceCatalog {
  evidence_registry_version: string;
  generated_at: string;
  disclaimer_policy: {
    non_diagnostic_flag: true;
    user_facing_text_ja: string;
    show_on_comparison_and_share: true;
  };
  studies: Study[];
  normative_metrics: NormativeMetric[];
}
