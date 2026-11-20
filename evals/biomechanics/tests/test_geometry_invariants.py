import json
import subprocess
import sys
from hashlib import sha256
from pathlib import Path

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from motion_engine.calibration import fit_dlt_view, projection_cameras
from motion_engine.contracts import (
    CalibrationParams,
    CaptureEvent,
    CoordinateEdit,
    CoordinateRevision,
    KinematicMetrics,
    Pose2DSequence,
    Pose3DSequence,
    ShareReportSnapshot,
)
from motion_engine.filtering import (
    PADLEN,
    CutoffBand,
    butterworth_lowpass,
    interpolate_3d,
    interpolate_image,
    winter_cutoff,
)
from motion_engine.kinematics import (
    AnatomicalFrame,
    angular_velocity,
    bone_length_sd_mm,
    femur_frame,
    humerus_frame,
    knee_joint_angles,
    linear_velocity_m_per_s,
    normalize_events,
    normalized_quaternion,
    pelvis_frame,
    thorax_frame,
    tibia_frame,
    verify_rotation,
)
from motion_engine.pipeline import (
    CONTRACT_VERSION,
    PipelineStages,
    PluginArtifact,
    run_calibrated_pipeline,
)
from motion_engine.plugins import load_plugin_manifest
from motion_engine.reconstruction import triangulate_point
from motion_engine.revisions import apply_revisions
from motion_engine.units import (
    CalibratedWorld3D,
    Camera3D,
    Degrees,
    DegreesPerSecond,
    HipRelative3D,
    Image2D,
    NormalizedTime,
    Radians,
    RadiansPerSecond,
    TimestampSeconds,
)
from pydantic import TypeAdapter, ValidationError
from scipy.spatial.transform import Rotation

from ..synthetic import (
    fit_calibrations,
    raised_cosine_pulse,
    synthetic_motion,
    virtual_rig,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages/contracts/fixtures"
MODELS = {
    "pose2d": TypeAdapter(Pose2DSequence),
    "pose3d": TypeAdapter(Pose3DSequence),
    "coordinate_revision": TypeAdapter(CoordinateRevision),
    "calibration": TypeAdapter(CalibrationParams),
    "kinematic_metrics": TypeAdapter(KinematicMetrics),
    "share_report": TypeAdapter(ShareReportSnapshot),
}


@pytest.fixture(scope="module")
def rig():
    return virtual_rig()


@pytest.fixture(scope="module")
def calibrations(rig):
    return fit_calibrations(rig)


@pytest.fixture(scope="module")
def running(rig):
    return synthetic_motion("running", rig)


def world(point):
    return CalibratedWorld3D(x=float(point[0]), y=float(point[1]), z=float(point[2]))


@settings(max_examples=60)
@given(
    x=st.floats(-0.4, 0.4),
    y=st.floats(-0.3, 0.3),
    depth=st.floats(1, 10),
    method_index=st.integers(0, 1),
)
def test_g1_project_and_triangulate(calibrations, x, y, depth, method_index):
    cameras, method = projection_cameras(calibrations[method_index])
    expected = world([x, y, depth - 4.8 if method == "dlt" else depth])
    observations = {}
    for camera in cameras:
        camera_point = camera.to_camera(expected)
        observations[camera_point.view_id] = camera.project(camera_point)
    actual = triangulate_point(cameras, observations, method)
    assert actual.distance_to(expected) < 1e-6


@pytest.mark.parametrize("index", [0, 1], ids=["dlt", "stereo"])
def test_g1_distorted_projection_roundtrip(rig, calibrations, index):
    original = np.array([[0.25, -0.12, 0.4]])
    observations = {
        view.view_id: Image2D(
            x=float(pixel[0]),
            y=float(pixel[1]),
            view_id=view.view_id,
            lens_undistorted=False,
        )
        for camera_index, view in enumerate(rig.views)
        for pixel in rig.project(original, camera_index)
    }
    cameras, method = projection_cameras(calibrations[index])
    expected = original[0] + ([0, 0, 4.8] if method == "stereo" else [0, 0, 0])
    assert (
        triangulate_point(cameras, observations, method).distance_to(world(expected))
        < 1e-6
    )


@pytest.mark.parametrize("depth", [100.0, -4.0], ids=["near-parallel", "behind"])
def test_g1_rejects_degenerate_depth(calibrations, depth):
    cameras, method = projection_cameras(calibrations[1])
    observations = {}
    for camera in cameras:
        p = camera.projection @ [0.25, 0.1, depth, 1.0]
        observations[camera.view.view_id] = Image2D(
            x=float(p[0] / p[2]),
            y=float(p[1] / p[2]),
            lens_undistorted=True,
            view_id=camera.view.view_id,
        )
    with pytest.raises(ValueError, match="parallel rays|invalid depth"):
        triangulate_point(cameras, observations, method)


def test_g1_rejects_coplanar_control_points(rig):
    points = np.array([[float(x), float(y), 0.0] for x in range(3) for y in range(3)])
    with pytest.raises(ValueError, match="non-coplanar"):
        fit_dlt_view(rig.views[0], points, rig.project(points, 0))


@settings(max_examples=45)
@given(
    length=st.floats(0.1, 2),
    roll=st.floats(-180, 180),
    yaw=st.floats(-180, 180),
    shift=st.floats(-5, 5),
    knee_deg=st.floats(0, 140),
)
def test_g2_anatomical_rotations_and_bone_lengths(length, roll, yaw, shift, knee_deg):
    rotation = Rotation.from_euler("xyz", [roll, 35, yaw], degrees=True)
    neutral = Rotation.from_euler("z", -knee_deg, degrees=True)
    translate = np.array([shift, -2 * shift, 0.25])

    def marker(x, y, z):
        return world(rotation.apply([x, y, z]) + translate)

    hip, knee = marker(0, length, 0), marker(0, 0, 0)
    left_knee, right_knee = marker(0, 0, -0.05), marker(0, 0, 0.05)
    left_ankle = marker(*neutral.apply([0, -length, -0.04]))
    right_ankle = marker(*neutral.apply([0, -length, 0.04]))
    expected_rotation = rotation.as_matrix()
    femur = femur_frame(hip, left_knee, right_knee)
    tibia = tibia_frame(knee, left_ankle, right_ankle)
    aligned = [
        pelvis_frame(
            marker(0, 0, -0.1),
            marker(0, 0, 0.1),
            marker(-0.12, 0, -0.1),
            marker(-0.12, 0, 0.1),
        ),
        thorax_frame(
            marker(0.15, 0.5, 0),
            marker(-0.1, 0.5, 0),
            marker(0.15, 0.1, 0),
            marker(-0.1, 0.1, 0),
        ),
        humerus_frame(hip, left_knee, right_knee),
        femur,
    ]
    for frame, expected in [(frame, expected_rotation) for frame in aligned] + [
        (tibia, expected_rotation @ neutral.as_matrix()),
    ]:
        assert np.max(np.abs(frame.rotation - expected)) <= 1e-9
        assert np.max(np.abs(frame.rotation.T @ frame.rotation - np.eye(3))) <= 1e-9
        assert abs(np.linalg.det(frame.rotation) - 1.0) <= 1e-9
        assert abs(np.linalg.norm(normalized_quaternion(frame.rotation)) - 1.0) <= 1e-9
    angles = knee_joint_angles(femur, tibia)
    assert angles.flexion.to_degrees().value == pytest.approx(knee_deg, abs=1e-9)
    assert angles.abduction.value == pytest.approx(0.0, abs=1e-9)
    assert angles.internal_rotation.value == pytest.approx(0.0, abs=1e-9)

    first_m, second_m = [], []
    for step in (0, 30, 90):
        transform = Rotation.from_euler("x", step, degrees=True) * rotation
        offset = translate + step / 100
        first_m.append(transform.apply([0, 0, 0]) + offset)
        second_m.append(transform.apply([0, length, 0]) + offset)
    first_m, second_m = np.array(first_m), np.array(second_m)
    assert np.max(np.abs(np.linalg.norm(second_m - first_m, axis=1) - length)) <= 1e-9
    endpoints = [(world(a), world(b)) for a, b in zip(first_m, second_m, strict=True)]
    assert bone_length_sd_mm(endpoints) == pytest.approx(0, abs=1e-6)


@pytest.mark.parametrize(
    "matrix", [np.diag([1, 1, -1]), np.diag([1, 1, 2]), np.full((3, 3), np.nan)]
)
def test_g2_rejects_non_so3(matrix):
    with pytest.raises(ValueError, match=r"SO\(3\)"):
        verify_rotation(matrix)


def test_g2_knee_jcs_resolves_all_three_rotations():
    origin = world([0, 0, 0])
    femur = AnatomicalFrame(origin, np.eye(3))
    tibia = AnatomicalFrame(
        origin, Rotation.from_euler("ZXY", [-120, -15, 25], degrees=True).as_matrix()
    )
    angles = knee_joint_angles(femur, tibia)
    assert [angle.to_degrees().value for angle in angles] == pytest.approx(
        [120, 15, 25], abs=1e-9
    )


def test_g3_frame_and_unit_runtime_boundaries():
    metric = world([1, 2, 3])
    hip = HipRelative3D(x=1, y=2, z=3)
    image = Image2D(x=1, y=2, view_id="left", lens_undistorted=True)
    other_view = image.model_copy(update={"view_id": "right"})
    other_space = image.model_copy(update={"lens_undistorted": False})
    with pytest.raises(TypeError):
        metric.distance_to(hip)
    with pytest.raises(TypeError):
        metric.distance_to(image)
    for incompatible_image in (other_view, other_space):
        with pytest.raises(TypeError):
            image.distance_to(incompatible_image)
    with pytest.raises(TypeError):
        Camera3D(x=1, y=2, z=3, view_id="left").distance_to(
            Camera3D(x=1, y=2, z=3, view_id="right")
        )
    with pytest.raises(TypeError):
        Degrees(value=30) + Radians(value=1)
    with pytest.raises(TypeError):
        RadiansPerSecond(value=1) - DegreesPerSecond(value=1)
    with pytest.raises(ValidationError):
        CalibratedWorld3D.model_validate_json(hip.model_dump_json())
    with pytest.raises(ValidationError, match="expected a boolean"):
        CalibratedWorld3D.model_validate_json(
            metric.model_dump_json().replace("true", "1")
        )
    with pytest.raises(ValidationError):
        Image2D.model_validate_json(image.model_dump_json().replace('"px"', '"m"'))
    with pytest.raises(ValidationError):
        Radians.model_validate_json(Degrees(value=30).model_dump_json())
    assert Degrees(value=180).to_radians().value == pytest.approx(np.pi)
    assert RadiansPerSecond(
        value=1
    ).to_degrees_per_second().to_radians_per_second().value == pytest.approx(1)


def test_g3_static_type_boundary(tmp_path):
    program = tmp_path / "type_boundary.py"
    program.write_text(
        """from motion_engine.units import CalibratedWorld3D, Degrees, DegreesPerSecond, HipRelative3D, Image2D, Radians, RadiansPerSecond

def wrong(w: CalibratedWorld3D, h: HipRelative3D, i: Image2D, a: Degrees, b: Radians,
          c: DegreesPerSecond, d: RadiansPerSecond) -> None:
    w.distance_to(h)
    i.distance_to(w)
    a + b
    c - d
    assigned: CalibratedWorld3D = h

def correct(w: CalibratedWorld3D, a: Degrees, b: Radians) -> None:
    w.distance_to(w)
    a + b.to_degrees()
""",
        encoding="utf-8",
    )
    check = subprocess.run(
        [sys.executable, "-m", "mypy", "--strict", "--no-error-summary", str(program)],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )
    assert check.returncode == 1, check.stdout + check.stderr
    messages = [line for line in check.stdout.splitlines() if "error:" in line]
    assert len(messages) == 5, check.stdout + check.stderr
    assert all(
        f":{line}: error:" in message
        for line, message in zip(range(5, 10), messages, strict=True)
    )


@settings(max_examples=45)
@given(
    amplitude=st.floats(0.25, 1),
    half_width=st.integers(6, 24),
    ratio=st.floats(0.05, 0.2),
)
def test_g4_zero_phase_and_symmetry(amplitude, half_width, ratio):
    pulse = raised_cosine_pulse(amplitude, half_width)
    filtered = butterworth_lowpass(pulse, 240, 240 * ratio)
    assert filtered.shape == pulse.shape
    assert np.isfinite(filtered).all()
    assert int(np.argmax(filtered)) == int(np.argmax(pulse))
    assert np.max(np.abs(filtered - filtered[::-1])) / amplitude <= 1e-9


@pytest.mark.parametrize("length", [0, PADLEN - 1, PADLEN])
def test_g4_rejects_short_series(length):
    with pytest.raises(ValueError, match="requires more than"):
        butterworth_lowpass(np.ones(length), 240, 20)


def test_g4_local_interpolation_tracks_source(running, calibrations):
    raw = running.raw[1]
    new = interpolate_image(raw)
    expected = "right_ankle_right_malleolus"
    inserted = next(
        point for point in new.frames[85].landmarks if point.landmark_id == expected
    )
    recorded = next(
        point for point in raw.frames[85].landmarks if point.landmark_id == expected
    )
    assert (
        recorded.source == "tracker_raw"
        and recorded.missing_reason == "occluded"
        and recorded.x is None
    )
    assert inserted.source == "spline_interpolated" and inserted.missing_reason is None

    result = run(running, calibrations[0], (), max_gap=0)
    repaired = interpolate_3d(result.pose)
    assert any(
        point.landmark_id == expected and point.source == "spline_interpolated"
        for point in repaired.frames[85].landmarks
    )
    assert any(
        point.landmark_id == expected and point.missing_reason == "occluded"
        for point in result.pose.frames[85].landmarks
    )


def test_g4_winter_cutoff_responds_to_band():
    seconds = np.arange(240) / 240
    values = np.sin(2 * np.pi * seconds * 10) + 0.05 * np.cos(2 * np.pi * seconds * 57)
    assert 4 <= winter_cutoff(values, 240, CutoffBand(4, 15)) <= 15
    assert 16 <= winter_cutoff(values, 240, CutoffBand(16, 36)) <= 36


@settings(max_examples=45)
@given(
    intervals=st.lists(st.floats(0.013, 0.15), min_size=3, max_size=16),
    angular_speed=st.floats(-3, 3),
    linear_speed=st.floats(-2, 2),
)
def test_g5_real_time_derivatives_before_event_normalization(
    intervals, angular_speed, linear_speed
):
    time = np.r_[0, np.cumsum(intervals)]
    angles = [Radians(value=0.2 + float(t) * angular_speed) for t in time]
    positions = [world([1 + linear_speed * t, 2, 3]) for t in time]
    for scale in (1, 2):
        stamps = [TimestampSeconds(timestamp_sec=float(t) * scale) for t in time]
        rates = np.array([rate.value for rate in angular_velocity(angles, stamps)])
        velocity = linear_velocity_m_per_s(positions, stamps)
        assert np.max(np.abs(rates - angular_speed / scale)) <= 1e-9
        np.testing.assert_allclose(
            velocity,
            np.tile([linear_speed / scale, 0, 0], (len(time), 1)),
            atol=1e-9,
            rtol=0,
        )
        samples = normalize_events(stamps, rates, stamps[0], stamps[-1], samples=5)
        assert [point.normalized_time_fraction for point in samples] == [
            0,
            0.25,
            0.5,
            0.75,
            1,
        ]
        assert all(
            abs(point.value - angular_speed / scale) <= 1e-9 for point in samples
        )


def test_g5_rejects_wrong_time_axes():
    start = TimestampSeconds(timestamp_sec=2)
    end = TimestampSeconds(timestamp_sec=3)
    values = [Radians(value=0.3), Radians(value=0.4)]
    with pytest.raises(TypeError, match="capture timestamps"):
        angular_velocity(
            values,
            [
                NormalizedTime(normalized_time_fraction=0),
                NormalizedTime(normalized_time_fraction=1),
            ],
        )
    for invalid in ([start, start], [end, start]):
        with pytest.raises(ValueError, match="strictly increase"):
            angular_velocity(values, invalid)
    with pytest.raises(ValueError, match="strictly increase"):
        normalize_events([start, end], np.array([1, 2]), start, start)


def test_g5_continuous_radians_can_exceed_half_a_turn_between_samples():
    stamps = [TimestampSeconds(timestamp_sec=t) for t in (0, 0.05, 0.11)]
    angles = [Radians(value=time.timestamp_sec * 120) for time in stamps]
    assert [rate.value for rate in angular_velocity(angles, stamps)] == pytest.approx(
        [120, 120, 120]
    )


def revision(operation, name, parent, edits=()):
    return CoordinateRevision(
        contract_version=CONTRACT_VERSION,
        revision_id=name,
        parent_revision_id=parent,
        expected_head=parent,
        operation=operation,
        edits=list(edits),
    )


@settings(max_examples=30)
@given(x=st.floats(100, 1500), y=st.floats(100, 900), missing=st.booleans())
def test_g6_edit_replay_is_immutable_and_reversible(running, x, y, missing):
    raw = running.raw[0]
    original = raw.model_dump_json()
    edit = running.edit.edits[0]
    updated = edit.landmark.model_copy(
        update={
            "x": None if missing else x,
            "y": None if missing else y,
            "missing_reason": "occluded" if missing else None,
        }
    )
    first = revision("edit", "a", "coordinates-raw", [edit])
    second = revision("edit", "b", "a", [edit.model_copy(update={"landmark": updated})])
    undo = revision("undo", "c", "b")
    redo = revision("redo", "d", "c")
    versions = [first, second, undo, redo]
    version_bytes = [item.model_dump_json() for item in versions]
    assert apply_revisions(raw, versions[:3]) == apply_revisions(raw, [first])
    assert apply_revisions(raw, versions) == apply_revisions(raw, versions[:2])
    assert apply_revisions(raw, [*versions, first]) == apply_revisions(raw, versions)
    assert apply_revisions(raw, [first, revision("undo", "reset", "a")]) == raw
    with pytest.raises(ValueError, match="nothing to redo"):
        branch = revision("edit", "new", "c", [edit])
        apply_revisions(
            raw, [first, second, undo, branch, revision("redo", "invalid", "new")]
        )
    with pytest.raises(ValueError, match="reused with different content"):
        apply_revisions(raw, [first, second.model_copy(update={"revision_id": "a"})])
    assert raw.model_dump_json() == original
    assert [item.model_dump_json() for item in versions] == version_bytes


def run(case, calibration, revisions, *, max_gap=4, events=None, **kwargs):
    from motion_engine.filtering import FilterSettings

    return run_calibrated_pipeline(
        case.raw,
        calibration,
        movement=case.movement,
        analysis_revision_id="deterministic-test",
        raw_revision_id="coordinates-raw",
        events=case.events if events is None else events,
        filter_settings=FilterSettings(max_gap_frames=max_gap),
        revisions=revisions,
        **kwargs,
    )


@pytest.mark.parametrize("index", [0, 1], ids=["dlt", "stereo"])
def test_g6_independent_recompute_reproduces_values_units_and_missing_reasons(
    running, calibrations, index
):
    calibration = calibrations[index]
    occluded = "right_ankle_right_malleolus"
    edits = []
    for frame in running.raw[1].frames[80:90]:
        point = next(
            point for point in frame.landmarks if point.landmark_id == occluded
        )
        edits.append(
            CoordinateEdit(
                view_id=running.raw[1].view_id,
                frame_index=frame.frame_index,
                landmark=point.model_copy(
                    update={
                        "x": None,
                        "y": None,
                        "source": "manual_edit",
                        "missing_reason": "occluded",
                    }
                ),
            )
        )
    hidden = revision("edit", "coordinates-gap", running.edit.revision_id, edits)
    mid = CaptureEvent(
        event_id="run_mid_stance",
        frame_index=85,
        timestamp_sec=float(running.time_sec[85]),
        detection_mode="manual",
        side="right",
    )
    events = [*running.events, mid]
    kwargs = {"events": events}
    original = [view.model_dump_json() for view in running.raw]
    first = run(running, calibration, [running.edit, hidden], **kwargs)
    second = run(
        running, calibration.model_copy(deep=True), [running.edit, hidden], **kwargs
    )
    assert first.pose.model_dump_json() == second.pose.model_dump_json()
    assert first.metrics.model_dump_json() == second.metrics.model_dump_json()
    np.testing.assert_array_equal(first.angle_series_deg, second.angle_series_deg)
    assert first.selected_cutoffs_hz == second.selected_cutoffs_hz
    assert first.metrics.provenance.calibration_id == calibration.calibration_id
    assert first.metrics.provenance.coordinate_revision_id == "coordinates-gap"
    assert len(first.metrics.provenance.stage_models) == 4
    assert first.metrics.scalar_metrics[-1].unit == "deg"
    assert first.metrics.scalar_metrics[-1].missing_reason_or_null == "occluded"
    assert not first.metrics.normalized_waveforms
    assert [view.model_dump_json() for view in running.raw] == original


@pytest.mark.parametrize(
    "path", sorted((FIXTURES / "valid").rglob("*.json")), ids=lambda path: path.name
)
def test_all_valid_shared_contracts_roundtrip(path):
    adapter = MODELS[path.name.split(".", 1)[0]]
    payload = path.read_bytes()
    value = adapter.validate_json(payload)
    encoded = adapter.dump_json(value)
    assert json.loads(encoded) == json.loads(payload)
    assert adapter.validate_json(encoded) == value


@pytest.mark.parametrize(
    "path", sorted((FIXTURES / "invalid").rglob("*.json")), ids=lambda path: path.name
)
def test_all_invalid_shared_contracts_are_rejected(path):
    adapter = MODELS[path.name.split(".", 1)[0]]
    with pytest.raises(ValidationError):
        adapter.validate_json(path.read_bytes())


@pytest.fixture
def plugin_files(tmp_path):
    model = tmp_path / "model.bin"
    model.write_bytes(b"synthetic plugin weights")
    path = tmp_path / "manifest.json"
    manifest = {
        "stage": "tracker_2d",
        "plugin_version": "1.2.3",
        "contract_compatibility": [CONTRACT_VERSION],
        "model_hash": sha256(model.read_bytes()).hexdigest(),
        "license_tier": "A",
        "license_attestation": {
            "attested_by": "Fixture Maintainer",
            "rights_evidence": "Fixture source",
            "intended_use": "test",
        },
    }
    return path, model, manifest


@pytest.mark.parametrize("tier", ["A", "B", "C"])
def test_plugin_licenses(plugin_files, tier):
    path, model, manifest = plugin_files
    path.write_text(json.dumps({**manifest, "license_tier": tier}), encoding="utf-8")
    arguments = dict(
        expected_stage="tracker_2d", contract_version=CONTRACT_VERSION, model_path=model
    )
    if tier == "A":
        assert load_plugin_manifest(path, **arguments).license_tier == tier
    else:
        with pytest.raises(ValueError, match="only Tier A"):
            load_plugin_manifest(path, **arguments)
        assert (
            load_plugin_manifest(
                path, commercial_default=False, **arguments
            ).license_tier
            == tier
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("stage", "reconstructor_3d"),
        ("plugin_version", "1.2"),
        ("contract_compatibility", ["1.2.0"]),
        ("contract_compatibility", []),
        ("contract_compatibility", "0.1.0"),
        ("model_hash", "0" * 64),
        ("model_hash", "bad-hash"),
        ("model_hash", "none"),
        ("license_tier", "D"),
        ("license_attestation", None),
        ("license_attestation", {"attested_by": "someone", "rights_evidence": " "}),
        ("extra", True),
    ],
)
def test_plugin_rejects_invalid_or_mismatched_manifest(plugin_files, field, value):
    path, model, manifest = plugin_files
    path.write_text(json.dumps({**manifest, field: value}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_plugin_manifest(
            path,
            expected_stage="tracker_2d",
            contract_version=CONTRACT_VERSION,
            model_path=model,
        )


def test_plugin_rejects_missing_files_and_unexpected_metadata(plugin_files):
    path, model, manifest = plugin_files
    arguments = dict(expected_stage="tracker_2d", contract_version=CONTRACT_VERSION)
    with pytest.raises(FileNotFoundError):
        load_plugin_manifest(path, model_path=model, **arguments)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="hash mismatch"):
        load_plugin_manifest(path, **arguments)
    with pytest.raises(ValueError, match="plugin version mismatch"):
        load_plugin_manifest(
            path, model_path=model, expected_plugin_version="1.2.4", **arguments
        )
    with pytest.raises(ValueError, match="license tier mismatch"):
        load_plugin_manifest(
            path, model_path=model, expected_license_tier="B", **arguments
        )
    model.unlink()
    with pytest.raises(FileNotFoundError):
        load_plugin_manifest(path, model_path=model, **arguments)


def test_pipeline_requires_manifest_before_invoking_plugin(
    running, calibrations, plugin_files
):
    path, model, manifest = plugin_files
    calls = []

    def tracker(video):
        calls.append(video)
        return running.raw[0] if video.name == "left.mp4" else running.raw[1]

    stages = PipelineStages(tracker=tracker)
    inputs = (Path("left.mp4"), Path("right.mp4"))
    args = dict(
        movement="running",
        analysis_revision_id="plugin-test",
        raw_revision_id="coordinates-raw",
        stages=stages,
    )
    with pytest.raises(ValueError, match="requires a plugin manifest"):
        run_calibrated_pipeline(inputs, calibrations[0], **args)
    path.write_text(json.dumps({**manifest, "license_tier": "C"}), encoding="utf-8")
    artifacts = {"tracker_2d": PluginArtifact(path, model)}
    with pytest.raises(ValueError, match="only Tier A"):
        run_calibrated_pipeline(inputs, calibrations[0], artifacts=artifacts, **args)
    assert not calls
    path.write_text(json.dumps(manifest), encoding="utf-8")
    result = run_calibrated_pipeline(
        inputs, calibrations[0], artifacts=artifacts, **args
    )
    assert calls == list(inputs)
    assert result.pose.provenance.stage_models[0].model_hash == manifest["model_hash"]
