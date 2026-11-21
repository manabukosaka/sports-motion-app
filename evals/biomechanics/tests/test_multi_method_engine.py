from hashlib import sha256
from itertools import product
from math import isfinite

import cv2
import numpy as np
import pytest
from motion_engine.calibration import (
    BoardObservation,
    calibrate_checkerboard_stereo,
    fit_dlt_calibration,
    projection_cameras,
)
from motion_engine.contracts import (
    AnalysisProvenance,
    CaptureEvent,
    CoordinateEdit,
    CoordinateRevision,
    Frame,
    Landmark2D,
    Landmark3D,
    MonocularReferenceCalibration,
    Pose2DSequence,
    Pose3DSequence,
)
from motion_engine.kinematics import (
    LANDING_EVENTS,
    calculate_kinematics,
    linear_velocity_m_per_s,
)
from motion_engine.monocular import iter_video_frames, read_video_metadata
from motion_engine.pipeline import (
    CONTRACT_VERSION,
    PluginArtifact,
    run_monocular_pipeline,
)
from motion_engine.plugins import LicenseAttestation, PluginManifest
from motion_engine.reconstruction import triangulate_point
from motion_engine.units import (
    CalibratedWorld3D,
    HipRelative3D,
    Image2D,
    TimestampSeconds,
)
from scipy.spatial.transform import Rotation

from ..run_eval import schema_validators
from ..synthetic import (
    IMAGE_SIZE,
    fit_calibrations,
    stereo_board_observations,
    synthetic_motion,
    virtual_rig,
)
from .test_cli_worker import analyze

ANALYSIS = {"analysis_revision_id": "multi-method", "raw_revision_id": "raw"}


@pytest.fixture(scope="module")
def schemas():
    return schema_validators()


@pytest.fixture
def video(tmp_path):
    path = tmp_path / "moving.avi"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 30, (64, 48))
    assert writer.isOpened()
    try:
        for index in range(40):
            writer.write(np.full((48, 64, 3), 5 * index, dtype=np.uint8))
    finally:
        writer.release()
    return path


def event(event_id, index, time, side=None):
    return CaptureEvent(
        event_id=event_id,
        frame_index=index,
        timestamp_sec=float(time),
        detection_mode="manual",
        **({"side": side} if side else {}),
    )


def reference(view):
    return MonocularReferenceCalibration(
        contract_version=CONTRACT_VERSION,
        calibration_id="reference",
        mode="monocular_reference",
        view_id=view,
    )


def monocular_view(times, scale=1.0, shift=(0, 0), image_size=(640, 480)):
    frames = []
    for index, timestamp in enumerate(times):
        theta = np.deg2rad(30 + 15 * np.cos(3 * timestamp))
        landmarks = {
            "left_hip": (28, 18),
            "right_hip": (32, 18),
            "right_knee": (32, 28),
            "right_ankle": (32 - 10 * np.sin(theta), 28 + 10 * np.cos(theta)),
            "right_shoulder": (33, 10),
        }
        frames.append(
            Frame[Landmark2D](
                frame_index=index,
                timestamp_sec=float(timestamp),
                landmarks=[
                    Landmark2D(
                        landmark_id=name,
                        x=float(scale * x + shift[0]),
                        y=float(scale * y + shift[1]),
                        source="tracker_raw",
                        missing_reason=None,
                        confidence=1,
                    )
                    for name, (x, y) in landmarks.items()
                ],
            )
        )
    return Pose2DSequence(
        contract_version=CONTRACT_VERSION,
        frames=frames,
        trial_id="mono",
        view_id="one",
        fps=float(1 / np.median(np.diff(times))),
        width_px=image_size[0],
        height_px=image_size[1],
        lens_undistorted=False,
        coordinate_frame="Image2D",
        unit="px",
    )


def artifact(tmp_path, stage, model_path=None, tier="A"):
    manifest = PluginManifest(
        stage=stage,
        plugin_version="1.0.0",
        contract_compatibility=[CONTRACT_VERSION],
        model_hash=sha256(model_path.read_bytes()).hexdigest()
        if model_path
        else "none",
        license_tier=tier,
        license_attestation=LicenseAttestation(
            attested_by="test",
            rights_evidence="synthetic fixture",
            intended_use="test",
        ),
    )
    manifest_path = tmp_path / f"{stage}.json"
    manifest_path.write_text(manifest.model_dump_json(), encoding="utf-8")
    return PluginArtifact(manifest_path, model_path)


def test_opencv_video_metadata_decode_and_tracker(video, tmp_path):
    metadata = read_video_metadata(video)
    assert (
        metadata.fps,
        metadata.frame_count,
        metadata.width_px,
        metadata.height_px,
    ) == (30, 40, 64, 48)
    frames = list(iter_video_frames(video))
    assert [frame.frame_index for frame in frames] == list(range(metadata.frame_count))
    np.testing.assert_allclose(
        [frame.timestamp_sec for frame in frames], np.arange(40) / 30, atol=0.001
    )
    assert all(
        frame.bgr.shape == (48, 64, 3) and frame.bgr.dtype == np.uint8
        for frame in frames
    )
    assert abs(float(frames[-1].bgr.mean()) - 195) <= 2

    def tracker(path):
        return monocular_view(
            [frame.timestamp_sec for frame in iter_video_frames(path)],
            image_size=(64, 48),
        )

    result = run_monocular_pipeline(
        video,
        reference("one"),
        movement="running",
        tracker=tracker,
        artifacts={"tracker_2d": artifact(tmp_path, "tracker_2d")},
        **ANALYSIS,
    )
    assert np.isfinite(result.angle_series_deg).all()
    assert len(result.pose.frames) == metadata.frame_count
    with pytest.raises(ValueError, match="cannot open video"):
        read_video_metadata(tmp_path / "missing.avi")


def test_video_estimator_preserves_provenance_and_cannot_claim_metric(video, tmp_path):
    model = tmp_path / "test-model.task"
    model.write_bytes(b"synthetic adapter fixture")
    artifacts = {"reconstructor_3d": artifact(tmp_path, "reconstructor_3d", model)}

    def estimator(observations, path, provenance):
        assert observations is None
        return Pose3DSequence(
            contract_version=provenance.contract_version,
            coordinate_frame="HipRelative3D",
            unit="m",
            is_metric_calibrated=False,
            provenance=provenance,
            bone_length_stability_mm=None,
            frames=[
                Frame[Landmark3D](
                    frame_index=frame.frame_index,
                    timestamp_sec=frame.timestamp_sec,
                    landmarks=[
                        Landmark3D(
                            landmark_id=name,
                            x=x,
                            y=y,
                            z=z,
                            source="tracker_raw",
                            missing_reason=None,
                        )
                        for name, (x, y, z) in {
                            "left_hip": (-0.1, 0.0, 0.0),
                            "right_hip": (0.1, 0.0, 0.0),
                            "right_knee": (0.1, -0.4, 0.1),
                            "right_ankle": (0.1, -0.7, -0.1),
                        }.items()
                    ],
                )
                for frame in iter_video_frames(path)
            ],
        )

    kwargs = {"movement": "running", "artifacts": artifacts, **ANALYSIS}
    result = run_monocular_pipeline(
        video, reference("one"), estimator=estimator, **kwargs
    )
    assert (
        result.pose.provenance.stage_models[2].model_hash
        == sha256(model.read_bytes()).hexdigest()
    )
    assert result.pose.frames[0].landmarks[-1].z == pytest.approx(-0.1)

    def claims_metric(observations, path, provenance):
        return estimator(observations, path, provenance).model_copy(
            update={
                "coordinate_frame": "CalibratedWorld3D",
                "is_metric_calibrated": True,
            }
        )

    with pytest.raises(TypeError, match="uncalibrated hip-relative"):
        run_monocular_pipeline(
            video, reference("one"), estimator=claims_metric, **kwargs
        )


def test_monocular_revision_scale_invariance_and_g3(schemas):
    time = np.arange(60) / 30
    view = monocular_view(time)
    events = [
        event("run_initial_contact", 0, time[0], "right"),
        event("run_initial_contact", 29, time[29], "left"),
        event("run_next_initial_contact", 59, time[59], "right"),
    ]
    kwargs = {"movement": "running", "events": events, **ANALYSIS}
    result = run_monocular_pipeline(view, reference("one"), **kwargs)
    scaled = run_monocular_pipeline(
        monocular_view(time, scale=3, shift=(90, 65)), reference("one"), **kwargs
    )
    np.testing.assert_allclose(
        result.angle_series_deg, scaled.angle_series_deg, atol=1e-9
    )
    assert np.isfinite(result.angle_series_deg).all()
    assert result.angle_series_deg[0] == pytest.approx(45, abs=0.5)
    assert set(result.selected_cutoffs_hz) == {"trunk_lower", "high_speed_upper"}
    assert result.pose.coordinate_frame == "HipRelative3D"
    assert result.pose.is_metric_calibrated is False
    assert result.pose.unit == "m" and result.pose.bone_length_stability_mm is None
    assert result.pose.provenance.calibration_id is None
    assert len(result.pose.provenance.stage_models) == 4
    hips = [point.axes() for point in result.pose.frames[0].landmarks[:2]]
    np.testing.assert_allclose(np.mean(hips, axis=0), np.zeros(3), atol=1e-14)
    schemas["pose3d"].validate(result.pose.model_dump(mode="json"))
    schemas["kinematics"].validate(result.metrics.model_dump(mode="json"))
    for metric in result.metrics.scalar_metrics:
        if metric.unit in ("m", "m_per_s"):
            assert metric.value_or_null is None
            assert metric.missing_reason_or_null == "insufficient_calibration"
    cadence = next(
        m for m in result.metrics.scalar_metrics if m.metric_id == "run_cadence"
    )
    assert cadence.value_or_null == pytest.approx(120 / time[-1])

    ankle = view.frames[25].landmarks[3]
    revision = CoordinateRevision(
        contract_version=CONTRACT_VERSION,
        revision_id="edit",
        expected_head="raw",
        parent_revision_id="raw",
        operation="edit",
        edits=[
            CoordinateEdit(
                view_id=view.view_id,
                frame_index=25,
                landmark=ankle.model_copy(update={"x": ankle.x - 3}),
            )
        ],
    )
    edited = run_monocular_pipeline(
        view, reference("one"), revisions=[revision], **kwargs
    )
    assert edited.pose.provenance.coordinate_revision_id == "edit"
    assert edited.pose.frames[25].landmarks[3].source == "manual_edit"
    assert edited.angle_series_deg[25] != pytest.approx(result.angle_series_deg[25])
    assert view.frames[25].landmarks[3] == ankle

    dlt, _ = fit_calibrations(virtual_rig())
    cameras, _ = projection_cameras(dlt)
    hip = HipRelative3D(x=0, y=0, z=0)
    with pytest.raises(TypeError):
        cameras[0].to_camera(hip)
    with pytest.raises(TypeError):
        CalibratedWorld3D(x=0, y=0, z=0).distance_to(hip)
    with pytest.raises(TypeError):
        linear_velocity_m_per_s(
            [hip, hip],
            [TimestampSeconds(timestamp_sec=0), TimestampSeconds(timestamp_sec=1)],
        )
    with pytest.raises(TypeError):
        calculate_kinematics(
            result.pose, "running", events, "unsafe", world_basis=np.eye(3)
        )


def test_checkerboard_stereo_fits_intrinsics_and_triangulates(schemas):
    rig = virtual_rig()
    observations = stereo_board_observations(rig)
    calibration = calibrate_checkerboard_stereo(
        "new-stereo",
        CONTRACT_VERSION,
        ("first", "second"),
        IMAGE_SIZE,
        observations[:7],
        observations[7:],
    )
    schemas["calibration"].validate(calibration.model_dump(mode="json"))
    assert calibration.fit_rms_px < 1e-3
    assert calibration.held_out_check.reprojection_error_px < 1e-3
    for actual, truth in zip(calibration.views, rig.views, strict=True):
        assert actual.intrinsics.fx_px == pytest.approx(truth.intrinsics.fx_px, abs=0.1)
        np.testing.assert_allclose(
            actual.distortion_coefficients, truth.distortion_coefficients, atol=0.002
        )
    world = np.array(list(product((-0.4, 0.4), (-0.3, 0.3), (-0.2, 0.2))))
    cameras, method = projection_cameras(calibration)
    for expected, p, q in zip(
        world + rig.translations_m[0],
        rig.project(world, 0),
        rig.project(world, 1),
        strict=True,
    ):
        actual = triangulate_point(
            cameras,
            {
                "first": Image2D(
                    x=p[0], y=p[1], view_id="first", lens_undistorted=False
                ),
                "second": Image2D(
                    x=q[0], y=q[1], view_id="second", lens_undistorted=False
                ),
            },
            method,
        )
        assert np.linalg.norm(np.array(actual.axes()) - expected) < 1e-4

    bad = observations[-1]
    reversed_corners = BoardObservation(bad.board_m, bad.first_px, bad.second_px[::-1])
    with pytest.raises(ValueError, match="below 0.5 px"):
        calibrate_checkerboard_stereo(
            "bad",
            CONTRACT_VERSION,
            ("first", "second"),
            IMAGE_SIZE,
            observations[:7],
            [reversed_corners],
        )


def test_coplanar_dlt_controls_are_rejected(schemas):
    rig = virtual_rig()
    controls = np.array(list(product((-0.4, 0.4), (-0.3, 0.0, 0.3), (0.0,))))
    checks = np.array([[-0.2, 0.0, -0.3], [0.5, 0.1, 0.4]])
    with pytest.raises(ValueError, match="non-coplanar control points"):
        fit_dlt_calibration(
            "flat",
            CONTRACT_VERSION,
            rig.views,
            controls,
            (rig.project(controls, 0), rig.project(controls, 1)),
            checks,
            (rig.project(checks, 0), rig.project(checks, 1)),
        )
    dlt, _ = fit_calibrations(rig)
    schemas["calibration"].validate(dlt.model_dump(mode="json"))
    assert dlt.held_out_check.reprojection_error_px < 1e-3
    assert dlt.held_out_check.known_distance_rmse_m < 1e-4


@pytest.mark.parametrize("mode", [None, "calibrated", "monocular"])
def test_cli_analyze_modes(mode, schemas):
    rig = virtual_rig()
    if mode == "monocular":
        view = monocular_view(np.arange(40) / 30)
        request = {
            "view": view.model_dump(mode="json"),
            "calibration": reference(view.view_id).model_dump(mode="json"),
        }
    else:
        case = synthetic_motion("running", rig, frame_count=40, occlude=False)
        view = case.raw[0]
        dlt, _ = fit_calibrations(rig)
        request = {
            "views": [view.model_dump(mode="json") for view in case.raw],
            "calibration": dlt.model_dump(mode="json"),
        }
    if mode is not None:
        request["mode"] = mode
    request.update(
        movement="running",
        **ANALYSIS,
        events=[
            event(label, index, view.frames[index].timestamp_sec).model_dump(
                mode="json"
            )
            for label, index in (
                ("run_initial_contact", 0),
                ("run_next_initial_contact", 39),
            )
        ],
    )
    result = analyze(request)
    schemas["pose3d"].validate(result["pose3d"])
    schemas["kinematics"].validate(result["kinematic_metrics"])
    assert result["pose3d"]["is_metric_calibrated"] is (mode != "monocular")
    assert result["kinematic_metrics"]["normalized_waveforms"]


def calibrated_pose(times, landmarks_at):
    return Pose3DSequence(
        contract_version=CONTRACT_VERSION,
        coordinate_frame="CalibratedWorld3D",
        unit="m",
        is_metric_calibrated=True,
        bone_length_stability_mm=None,
        provenance=AnalysisProvenance(
            contract_version=CONTRACT_VERSION,
            pipeline_version="1.0.0",
            stage_models=[
                {"stage": "reconstructor_3d", "model_hash": "none", "license_tier": "A"}
            ],
            filter_spec_version="1.0.0",
            calibration_id_or_none="lab",
            coordinate_revision_id="raw",
        ),
        frames=[
            Frame[Landmark3D](
                frame_index=index,
                timestamp_sec=float(time),
                landmarks=[
                    Landmark3D(
                        landmark_id=name,
                        x=float(x),
                        y=float(y),
                        z=float(z),
                        source="tracker_raw",
                        missing_reason=None,
                    )
                    for name, (x, y, z) in landmarks_at(time).items()
                ],
            )
            for index, time in enumerate(times)
        ],
    )


def lower_body(time):
    travel = np.array([2 * time, 0.0, 0.0])
    points = {
        "left_asis": np.array([0.08, 1.0, -0.15]) + travel,
        "right_asis": np.array([0.08, 1.0, 0.15]) + travel,
        "left_psis": np.array([-0.08, 1.0, -0.15]) + travel,
        "right_psis": np.array([-0.08, 1.0, 0.15]) + travel,
    }
    for side, lateral in (("right", 0.15), ("left", -0.15)):
        hip = travel + [0, 1.0, lateral]
        knee = hip + [0.2, -0.4, 0]
        ankle = knee + [-0.1, -0.4, 0]
        for name, position in {
            "hip": hip,
            "knee": knee,
            "ankle": ankle,
            "knee_left_epicondyle": knee + [0, 0, -0.045],
            "knee_right_epicondyle": knee + [0, 0, 0.045],
            "ankle_left_malleolus": ankle + [0, 0, -0.035],
            "ankle_right_malleolus": ankle + [0, 0, 0.035],
            "heel": ankle + [-0.06, -0.07, 0],
            "foot_index": ankle + [0.14, -0.07, 0],
            "fifth_metatarsal": ankle + [0.13, -0.07, np.copysign(0.04, lateral)],
        }.items():
            points[f"{side}_{name}"] = position
    return points


def test_running_bilateral_waveforms_and_metric_stride(schemas):
    times = np.linspace(0, 1.5, 91)
    pose = calibrated_pose(times, lower_body)
    events = [
        event(label, index, times[index], side)
        for label, index, side in (
            ("run_initial_contact", 0, "right"),
            ("run_mid_stance", 10, "right"),
            ("run_toe_off", 20, "right"),
            ("run_initial_contact", 30, "left"),
            ("run_mid_stance", 40, "left"),
            ("run_toe_off", 50, "left"),
            ("run_next_initial_contact", 60, "right"),
            ("run_next_initial_contact", 90, "left"),
        )
    ]
    _, metrics, _ = calculate_kinematics(
        pose, "running", events, "lab", world_basis=np.eye(3)
    )
    schemas["kinematics"].validate(metrics.model_dump(mode="json"))
    right = {
        m.metric_id: m.value_or_null
        for m in metrics.scalar_metrics
        if m.side == "right"
    }
    assert right["run_stride_length"] == pytest.approx(2)
    assert right["run_mean_forward_speed"] == pytest.approx(2)
    assert right["run_hip_flexion_extension_angle"] == pytest.approx(
        np.rad2deg(np.arctan(0.5))
    )
    assert right["run_pelvic_obliquity_angle"] == pytest.approx(0)
    assert right["run_ankle_dorsiflexion_plantarflexion_angle"] == pytest.approx(
        np.rad2deg(np.arctan(0.25))
    )
    assert (
        next(
            m.value_or_null
            for m in metrics.scalar_metrics
            if m.metric_id == "run_cadence"
        )
        == 120
    )
    assert {wave.metric_id for wave in metrics.normalized_waveforms} == {
        "run_hip_flexion_extension_angle",
        "run_knee_flexion_extension_angle",
        "run_ankle_dorsiflexion_plantarflexion_angle",
        "run_pelvic_obliquity_angle",
        "run_hip_adduction_angle",
    }
    for wave in metrics.normalized_waveforms:
        assert len(wave.points) == 101
        assert wave.points[0].normalized_time_fraction == 0
        assert wave.points[-1].normalized_time_fraction == 1
        assert all(isfinite(point.value) for point in wave.points)
    assert {wave.side for wave in metrics.normalized_waveforms} == {"left", "right"}
    assert {wave.interval_id for wave in metrics.normalized_waveforms} == {
        "run_stride",
        "run_stance",
    }


@pytest.mark.parametrize(
    ("movement", "schedule", "takeoff_index"),
    [
        (
            "cmj",
            {
                "cmj_initiation": 0,
                "cmj_peak_flexion": 15,
                "cmj_takeoff": 20,
                "cmj_initial_landing_contact": 55,
                "cmj_peak_landing_flexion": 59,
            },
            20,
        ),
        (
            "dvj",
            {
                "dvj_initial_landing_contact": 0,
                "dvj_peak_landing_flexion": 15,
                "dvj_takeoff": 30,
                "dvj_rebound_landing_contact": 59,
            },
            30,
        ),
    ],
)
def test_jump_landing_angles_and_center_of_mass(
    schemas, movement, schedule, takeoff_index
):
    times = np.arange(60) / 100

    def landmarks(time):
        dt = time - times[takeoff_index]
        return lower_body(time) | {"center_of_mass": (0, 1 + 2 * dt - 5 * dt**2, 0)}

    pose = calibrated_pose(times, landmarks)
    events = [event(label, index, times[index]) for label, index in schedule.items()]
    _, metrics, _ = calculate_kinematics(
        pose, movement, events, "lab", world_basis=np.eye(3)
    )
    schemas["kinematics"].validate(metrics.model_dump(mode="json"))
    assert len(metrics.normalized_waveforms) == 8
    landing_angles = [m for m in metrics.scalar_metrics if m.unit == "deg"]
    assert len(landing_angles) == 16 and all(
        m.value_or_null is not None for m in landing_angles
    )
    assert {m.event_id for m in landing_angles} == set(LANDING_EVENTS[movement])
    linear = {m.metric_id: m for m in metrics.scalar_metrics if m.unit != "deg"}
    assert linear["jump_com_rise"].value_or_null == pytest.approx(0.2)
    assert linear["jump_takeoff_vertical_com_velocity"].value_or_null == pytest.approx(
        2
    )
    _, unaligned, _ = calculate_kinematics(pose, movement, events, "unaligned")
    assert all(
        m.value_or_null is None
        and m.missing_reason_or_null == "insufficient_calibration"
        for m in unaligned.scalar_metrics
        if m.metric_id in linear
    )
    view = monocular_view(times)
    monocular = run_monocular_pipeline(
        view, reference("one"), movement=movement, events=events, **ANALYSIS
    )
    schemas["kinematics"].validate(monocular.metrics.model_dump(mode="json"))
    assert all(
        m.value_or_null is None
        and m.missing_reason_or_null == "insufficient_calibration"
        for m in monocular.metrics.scalar_metrics
        if m.metric_id in linear
    )
    assert any(
        m.value_or_null is not None
        for m in monocular.metrics.scalar_metrics
        if m.metric_id == "jump_landing_knee_flexion_angle"
    )


def test_pitch_isb_angles_and_angular_rates_use_capture_time(schemas):
    times = (np.linspace(0, 1, 60) ** 1.3) * 2

    def landmarks(time):
        yaw = 0.5 * time
        thorax = Rotation.from_euler("y", yaw)
        humerus = thorax * Rotation.from_euler("YXY", [0.2, -0.8, 0.35 * time])
        shoulder = np.array([0.02, 1.5, 0.2])
        elbow = shoulder + humerus.apply([0, -0.3, 0])
        wrist = elbow + humerus.apply(
            Rotation.from_euler("z", 1.3 - 0.4 * time).apply([0, -0.25, 0])
        )
        return {
            **{
                name: thorax.apply(axes)
                for name, axes in {
                    "left_asis": (0.1, 1, -0.15),
                    "right_asis": (0.1, 1, 0.15),
                    "left_psis": (-0.1, 1, -0.15),
                    "right_psis": (-0.1, 1, 0.15),
                    "jugular_notch": (0.08, 1.5, 0),
                    "c7": (-0.08, 1.5, 0),
                    "xiphoid": (0.08, 1.1, 0),
                    "t8": (-0.08, 1.1, 0),
                }.items()
            },
            "right_shoulder": shoulder,
            "right_elbow": elbow,
            "right_wrist": wrist,
            "right_elbow_left_epicondyle": elbow + humerus.apply([0, 0, -0.04]),
            "right_elbow_right_epicondyle": elbow + humerus.apply([0, 0, 0.04]),
        }

    pose = calibrated_pose(times, landmarks)
    events = [
        event(label, index, times[index], "right")
        for label, index in (
            ("pitch_leg_lift", 0),
            ("pitch_foot_contact", 14),
            ("pitch_mer", 24),
            ("pitch_ball_release", 30),
            ("pitch_mir", 59),
        )
    ]
    _, metrics, _ = calculate_kinematics(
        pose, "baseball_pitching", events, "lab", world_basis=np.eye(3)
    )
    schemas["kinematics"].validate(metrics.model_dump(mode="json"))
    rates = {
        m.metric_id: m.value_or_null
        for m in metrics.scalar_metrics
        if m.unit == "deg_per_s"
    }
    assert rates["pitch_pelvis_peak_rotation_angular_velocity"] == pytest.approx(
        np.rad2deg(0.5)
    )
    assert rates["pitch_thorax_peak_rotation_angular_velocity"] == pytest.approx(
        np.rad2deg(0.5)
    )
    assert rates[
        "pitch_shoulder_peak_internal_rotation_angular_velocity"
    ] == pytest.approx(np.rad2deg(0.35))
    assert rates["pitch_elbow_peak_extension_angular_velocity"] == pytest.approx(
        np.rad2deg(0.4)
    )
    elbow = next(
        wave
        for wave in metrics.normalized_waveforms
        if wave.metric_id == "pitch_elbow_flexion_angle"
    )
    assert elbow.points[-1].value == pytest.approx(np.rad2deg(1.3 - 0.4 * times[-1]))
    shoulder = next(
        wave
        for wave in metrics.normalized_waveforms
        if wave.metric_id == "pitch_shoulder_axial_rotation_angle"
    )
    assert shoulder.points[-1].value == pytest.approx(np.rad2deg(0.35 * times[-1]))
    assert len(metrics.normalized_waveforms) == 4

    _, partial, _ = calculate_kinematics(
        pose, "baseball_pitching", events[:-1], "partial"
    )
    assert not partial.normalized_waveforms


def test_monocular_pitch_reports_extension_speed(schemas):
    times = np.arange(60) / 30
    view = monocular_view(times)
    for frame in view.frames:
        angle = np.deg2rad(85 - 20 * frame.timestamp_sec)
        frame.landmarks.extend(
            Landmark2D(
                landmark_id=name,
                x=float(x),
                y=float(y),
                source="tracker_raw",
                missing_reason=None,
                confidence=1,
            )
            for name, (x, y) in {
                "right_elbow": (33, 20),
                "right_wrist": (33 + 8 * np.sin(angle), 20 + 8 * np.cos(angle)),
            }.items()
        )
    events = [
        event(label, index, times[index], "right")
        for label, index in (
            ("pitch_leg_lift", 5),
            ("pitch_ball_release", 30),
            ("pitch_mir", 54),
        )
    ]
    result = run_monocular_pipeline(
        view, reference("one"), movement="baseball_pitching", events=events, **ANALYSIS
    )
    schemas["kinematics"].validate(result.metrics.model_dump(mode="json"))
    peak = next(
        m
        for m in result.metrics.scalar_metrics
        if m.metric_id == "pitch_elbow_peak_extension_angular_velocity"
    )
    assert peak.unit == "deg_per_s"
    assert peak.value_or_null == pytest.approx(20, abs=0.25)
    assert all(
        m.value_or_null is None and m.missing_reason_or_null == "unidentifiable_axis"
        for m in result.metrics.scalar_metrics
        if m.metric_id == "pitch_shoulder_axial_rotation_angle"
    )
