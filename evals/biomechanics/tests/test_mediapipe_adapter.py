import io
import json
import subprocess
import sys
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import cv2
import pytest
from motion_engine import (
    MediaPipePoseAdapter,
    MediaPipeWorldLandmark,
    create_mediapipe_tasks_backend,
    mediapipe_adapter,
)
from motion_engine.cli import main, output_validators
from motion_engine.contracts import AnalysisProvenance
from motion_engine.monocular import iter_video_frames
from motion_engine.pipeline import PluginArtifact, run_monocular_pipeline
from motion_engine.plugins import load_plugin_manifest

from ..benchmark_monocular import (
    FPS,
    FRAME_COUNT,
    P95_LIMIT_SEC,
    RESOLUTION,
    running_events,
    synthetic_backend,
    write_synthetic_plugin,
    write_synthetic_video,
)
from .test_multi_method_engine import ANALYSIS, event, reference

BENCHMARK = Path(__file__).resolve().parents[1] / "benchmark_monocular.py"


@pytest.fixture
def video(tmp_path):
    path = tmp_path / "pose.avi"
    write_synthetic_video(path, frame_count=FPS + 1)
    return path


@pytest.fixture
def plugin(tmp_path):
    model, manifest = write_synthetic_plugin(tmp_path)
    return PluginArtifact(manifest, model)


@pytest.fixture
def provenance():
    return AnalysisProvenance(
        contract_version="0.1.0",
        pipeline_version="0.2.0",
        stage_models=[
            {"stage": "reconstructor_3d", "model_hash": "none", "license_tier": "A"}
        ],
        filter_spec_version="0.2.0",
        calibration_id_or_none="none",
        coordinate_revision_id="raw",
    )


def test_mapping_clock_rgb_and_hip_relative_axes(video, provenance):
    timestamps = []

    def backend(rgb, timestamp):
        timestamps.append(timestamp)
        if timestamp == 0:
            assert (rgb == cv2.cvtColor(first.bgr, cv2.COLOR_BGR2RGB)).all()
        return [
            MediaPipeWorldLandmark(index, index * 2, index * 3, 0.5, 1.0)
            for index in range(33)
        ]

    decoded = list(iter_video_frames(video))
    first = decoded[0]
    pose = MediaPipePoseAdapter(backend)(None, video, provenance)
    assert timestamps == [round(frame.timestamp_sec * 1000) for frame in decoded]
    assert all(a < b for a, b in zip(timestamps, timestamps[1:]))
    assert [frame.timestamp_sec for frame in pose.frames] == [
        frame.timestamp_sec for frame in decoded
    ]
    assert (pose.coordinate_frame, pose.unit) == ("HipRelative3D", "m")
    assert pose.is_metric_calibrated is False
    assert pose.bone_length_stability_mm is None
    assert pose.provenance == provenance
    expected = (
        "nose left_eye_inner left_eye left_eye_outer right_eye_inner right_eye "
        "right_eye_outer left_ear right_ear left_mouth right_mouth left_shoulder "
        "right_shoulder left_elbow right_elbow left_wrist right_wrist left_pinky "
        "right_pinky left_index right_index left_thumb right_thumb left_hip "
        "right_hip left_knee right_knee left_ankle right_ankle left_heel right_heel "
        "left_foot_index right_foot_index pelvis"
    ).split()
    for frame in pose.frames:
        assert [point.landmark_id for point in frame.landmarks] == expected
        for index, point in enumerate(frame.landmarks[:-1]):
            delta = index - 23.5
            assert point.axes() == (delta, -2 * delta, 3 * delta)
            assert point.source == "tracker_raw"
            assert point.missing_reason is None
        assert frame.landmarks[-1].axes() == (0.0, 0.0, 0.0)


def test_visibility_nonfinite_and_no_pose(video, provenance):
    def backend(rgb, timestamp):
        if timestamp == 0:
            return None
        points = synthetic_backend(rgb, timestamp)
        points[0] = replace(points[0], visibility=0.59)
        points[1] = replace(points[1], x=float("nan"))
        points[2] = replace(points[2], y=float("inf"))
        points[3] = replace(points[3], z=float("-inf"))
        points[4] = replace(points[4], visibility=float("nan"))
        points[5] = replace(points[5], visibility=0.60)
        points[6] = replace(points[6], visibility=None)
        if timestamp == 33:
            points[23] = replace(points[23], visibility=0.1)
        return points

    pose = MediaPipePoseAdapter(backend, min_visibility=0.6)(None, video, provenance)
    no_pose, low_confidence, missing_hip = pose.frames[:3]
    for point in no_pose.landmarks:
        assert point.axes() == (None, None, None)
        assert point.missing_reason == "occluded"
    for point in low_confidence.landmarks[:5]:
        assert point.axes() == (None, None, None)
        assert point.missing_reason == "low_confidence"
    assert low_confidence.landmarks[5].missing_reason is None
    assert low_confidence.landmarks[6].missing_reason == "low_confidence"
    assert missing_hip.landmarks[23].missing_reason == "low_confidence"
    assert missing_hip.landmarks[-1].missing_reason == "low_confidence"
    assert all(point.axes() == (None, None, None) for point in missing_hip.landmarks)
    json.dumps(pose.model_dump(mode="json"), allow_nan=False)


def test_centering_rejects_overflow(video, provenance):
    def backend(rgb, timestamp):
        points = synthetic_backend(rgb, timestamp)
        for index, x in ((0, -1.7e308), (23, 1.7e308), (24, 1.7e308)):
            points[index] = replace(points[index], x=x)
        return points

    pose = MediaPipePoseAdapter(backend)(None, video, provenance)
    point = pose.frames[0].landmarks[0]
    assert point.axes() == (None, None, None)
    assert point.missing_reason == "low_confidence"
    json.dumps(pose.model_dump(mode="json"), allow_nan=False)


def test_missing_tasks_runtime_has_actionable_error(monkeypatch, plugin):
    def missing(name):
        assert name == "mediapipe"
        raise ModuleNotFoundError(name)

    monkeypatch.setattr(mediapipe_adapter.importlib, "import_module", missing)
    with pytest.raises(RuntimeError, match=r"uv run --with mediapipe"):
        with create_mediapipe_tasks_backend(plugin.model_path):
            pytest.fail("a missing optional dependency must prevent inference")


def analyze_video(
    video, plugin, movement="running", events=None, backend=synthetic_backend
):
    return run_monocular_pipeline(
        video,
        reference("video"),
        movement=movement,
        events=running_events(video) if events is None else events,
        estimator=MediaPipePoseAdapter(backend),
        artifacts={"reconstructor_3d": plugin},
        **ANALYSIS,
    )


def validate_contracts(pose, metrics):
    pose_validator, metrics_validator = output_validators()
    pose_validator.validate(pose)
    metrics_validator.validate(metrics)


def test_opencv_pipeline_schema_and_metric_refusal(video, plugin):
    result = analyze_video(video, plugin)
    validate_contracts(
        result.pose.model_dump(mode="json"), result.metrics.model_dump(mode="json")
    )
    assert len(result.pose.frames) == FPS + 1
    assert result.selected_cutoffs_hz
    assert any(
        wave.metric_id == "run_knee_flexion_extension_angle"
        for wave in result.metrics.normalized_waveforms
    )
    reconstructor = next(
        model
        for model in result.pose.provenance.stage_models
        if model.stage == "reconstructor_3d"
    )
    assert reconstructor.license_tier == "A"
    assert (
        reconstructor.model_hash == sha256(plugin.model_path.read_bytes()).hexdigest()
    )
    linear = [
        metric
        for metric in result.metrics.scalar_metrics
        if metric.unit in {"m", "m_per_s"}
    ]
    assert {metric.metric_id for metric in linear} == {
        "run_stride_length",
        "run_mean_forward_speed",
    }
    assert all(
        metric.value_or_null is None
        and metric.missing_reason_or_null == "insufficient_calibration"
        for metric in linear
    )
    assert_unidentifiable_angles(
        result.metrics.scalar_metrics,
        {
            "run_hip_flexion_extension_angle",
            "run_hip_adduction_angle",
            "run_ankle_dorsiflexion_plantarflexion_angle",
        },
    )


def assert_unidentifiable_angles(metrics, expected):
    angles = [metric for metric in metrics if metric.metric_id in expected]
    assert {metric.metric_id for metric in angles} == expected
    assert all(
        metric.value_or_null is None
        and metric.missing_reason_or_null == "unidentifiable_axis"
        for metric in angles
    )


@pytest.mark.parametrize("movement", ["cmj", "dvj"])
def test_jump_anatomical_axes_stay_unidentifiable(video, plugin, movement):
    frames = list(iter_video_frames(video))
    events = [
        event(f"{movement}_{label}", i, frames[i].timestamp_sec)
        for label, i in (("initial_landing_contact", 20), ("peak_landing_flexion", 40))
    ]
    result = analyze_video(video, plugin, movement, events)
    assert_unidentifiable_angles(
        result.metrics.scalar_metrics,
        {
            "jump_landing_hip_flexion_angle",
            "jump_landing_knee_abduction_angle",
            "jump_landing_ankle_dorsiflexion_angle",
        },
    )


def test_pitching_axial_angle_stays_unidentifiable(video, plugin):
    frames = list(iter_video_frames(video))
    events = [
        event(label, index, frames[index].timestamp_sec, "right")
        for label, index in (("pitch_leg_lift", 0), ("pitch_mir", FPS))
    ]
    result = analyze_video(video, plugin, "baseball_pitching", events)
    metrics = result.metrics.scalar_metrics
    assert_unidentifiable_angles(metrics, {"pitch_shoulder_axial_rotation_angle"})
    assert any(
        metric.metric_id == "pitch_elbow_flexion_angle"
        and metric.value_or_null is not None
        for metric in metrics
    )


@pytest.mark.parametrize("fault", ["artifact", "manifest_hash", "B", "C", "version"])
def test_plugin_is_verified_before_inference(video, plugin, fault):
    assert (
        load_plugin_manifest(
            plugin.manifest_path,
            expected_stage="reconstructor_3d",
            contract_version="0.1.0",
            model_path=plugin.model_path,
        ).license_tier
        == "A"
    )
    manifest = json.loads(plugin.manifest_path.read_bytes())
    if fault == "artifact":
        plugin.model_path.write_bytes(b"modified")
    elif fault == "manifest_hash":
        manifest["model_hash"] = "0" * 64
    elif fault == "version":
        plugin = replace(plugin, expected_plugin_version="9.9.9")
    else:
        manifest["license_tier"] = fault
    plugin.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def unexpected(*args):
        pytest.fail("manifest verification must run before inference")

    with pytest.raises(ValueError, match="model hash|Tier A|plugin version"):
        analyze_video(video, plugin, events=[], backend=unexpected)


def test_adapter_cannot_open_model_different_from_verified_artifact(
    video, plugin, tmp_path, monkeypatch
):
    other_model = tmp_path / "other.task"
    other_model.write_bytes(b"different model")

    def unexpected(name):
        pytest.fail("a mismatched model must be rejected before MediaPipe is loaded")

    monkeypatch.setattr(mediapipe_adapter.importlib, "import_module", unexpected)
    with pytest.raises(ValueError, match="model hash mismatch"):
        analyze_video(video, plugin, events=[], backend=other_model)


@pytest.fixture
def request_payload(video, plugin):
    return {
        "video_path": str(video),
        "model_path": str(plugin.model_path),
        "manifest_path": str(plugin.manifest_path),
        "calibration": reference("video").model_dump(mode="json"),
        "movement": "running",
        "events": [item.model_dump(mode="json") for item in running_events(video)],
        **ANALYSIS,
    }


def invoke_cli(monkeypatch, payload):
    monkeypatch.setattr(sys, "argv", ["motion_engine.cli", "analyze-video"])
    monkeypatch.setattr(
        sys, "stdin", io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))
    )
    return main()


@pytest.mark.parametrize(
    "fault",
    [
        "missing_video",
        "directory",
        "manifest",
        "model",
        "manifest_json",
        "manifest_schema",
    ],
)
def test_cli_rejects_invalid_video_or_plugin(
    request_payload, fault, monkeypatch, capsys
):
    if fault in {"missing_video", "directory"}:
        parent = Path(request_payload["video_path"]).parent
        request_payload["video_path"] = str(
            parent / "missing.avi" if fault == "missing_video" else parent
        )
    elif fault.startswith("manifest"):
        manifest_path = Path(request_payload["manifest_path"])
        manifest = json.loads(manifest_path.read_bytes())
        if fault == "manifest_json":
            contents = "{not valid JSON"
        elif fault == "manifest_schema":
            contents = json.dumps(manifest | {"model_hash": "invalid"})
        else:
            contents = json.dumps(manifest | {"license_tier": "B"})
        manifest_path.write_text(contents, encoding="utf-8")
    else:
        Path(request_payload["model_path"]).write_bytes(b"tampered")

    def unexpected(*args, **kwargs):
        pytest.fail("invalid inputs must be rejected before opening MediaPipe")

    monkeypatch.setattr(mediapipe_adapter, "create_mediapipe_tasks_backend", unexpected)
    assert invoke_cli(monkeypatch, request_payload) == 2
    captured = capsys.readouterr()
    assert not captured.out
    assert json.loads(captured.err) == {"error": "invalid_analysis_input"}


def test_cli_validated_video_output(request_payload, monkeypatch, capsys):
    @contextmanager
    def backend(model_path, *, expected_model_hash):
        assert model_path == Path(request_payload["model_path"])
        assert expected_model_hash == sha256(model_path.read_bytes()).hexdigest()
        yield synthetic_backend

    monkeypatch.setattr(mediapipe_adapter, "create_mediapipe_tasks_backend", backend)
    assert invoke_cli(monkeypatch, request_payload) == 0
    captured = capsys.readouterr()
    assert not captured.err
    output = json.loads(captured.out)
    validate_contracts(output["pose3d"], output["kinematic_metrics"])
    assert len(output["pose3d"]["frames"]) == FPS + 1
    assert output["non_diagnostic_flag"] is True
    assert output["disclaimer_text_ja"]
    assert output["evidence_comparisons"] == []
    assert output["selected_cutoffs_hz"]


def test_cli_runtime_failure(request_payload, monkeypatch, capsys):
    monkeypatch.setattr(
        mediapipe_adapter,
        "create_mediapipe_tasks_backend",
        lambda *_, **__: nullcontext(
            lambda *_: [MediaPipeWorldLandmark(0, 0, 0, 1, 1)]
        ),
    )
    assert invoke_cli(monkeypatch, request_payload) == 1
    captured = capsys.readouterr()
    assert not captured.out
    assert json.loads(captured.err) == {"error": "analysis_failed"}


def test_benchmark_smoke():
    process = subprocess.run(
        [sys.executable, str(BENCHMARK), "--runs", "1", "--json"],
        capture_output=True,
        encoding="utf-8",
        timeout=P95_LIMIT_SEC + 30,
    )
    assert process.returncode == 0, process.stderr
    output = json.loads(process.stdout)
    assert output["passed"] is True
    assert output["mode"] == "synthetic"
    assert output["frame_count"] == FRAME_COUNT == 600
    assert output["fps"] == FPS == 60
    assert output["resolution"] == list(RESOLUTION)
    assert output["frames_with_visible_pelvis"] == [FRAME_COUNT]
    assert (
        0
        < output["min_sec"]
        == output["p50_sec"]
        == output["p95_sec"]
        == output["max_sec"]
        <= 60.0
    )
    assert output["effective_fps"] == pytest.approx(FRAME_COUNT / output["p50_sec"])
