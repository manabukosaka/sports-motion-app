import json
import subprocess
import sys

import pytest
from motion_engine.cli import output_validators

from ..synthetic import fit_calibrations, synthetic_motion, virtual_rig


@pytest.fixture
def payload():
    rig = virtual_rig()
    case = synthetic_motion("running", rig, frame_count=40, occlude=False)
    calibration, _ = fit_calibrations(rig)
    return {
        "views": [
            dict(view.model_dump(mode="json"), contract_version="1.0.0")
            for view in case.raw
        ],
        "calibration": dict(
            calibration.model_dump(mode="json"), contract_version="1.0.0"
        ),
        "movement": "running",
        "analysis_revision_id": "cli-running",
        "raw_revision_id": "coordinates-raw",
        "events": [event.model_dump(mode="json") for event in case.events],
    }


def invoke(payload):
    return subprocess.run(
        [sys.executable, "-m", "motion_engine.cli", "analyze"],
        input=json.dumps(payload),
        capture_output=True,
        encoding="utf-8",
        timeout=30,
    )


def analyze(payload):
    process = invoke(payload)
    assert process.returncode == 0, process.stderr
    assert not process.stderr
    return json.loads(process.stdout)


def test_cli_validates_output(payload):
    output = analyze(payload)
    pose_validator, metrics_validator = output_validators()
    pose_validator.validate(output["pose3d"])
    metrics_validator.validate(output["kinematic_metrics"])
    assert output["pose3d"]["coordinate_frame"] == "CalibratedWorld3D"
    assert output["pose3d"]["is_metric_calibrated"] is True
    assert output["pose3d"]["contract_version"] == "1.0.0"
    assert output["kinematic_metrics"]["analysis_revision_id"] == "cli-running"
    assert output["selected_cutoffs_hz"]
    assert output["non_diagnostic_flag"] is True
    assert output["evidence_comparisons"] == []


def test_cli_applies_edits_deterministically(payload):
    baseline = analyze(payload)
    view = payload["views"][0]
    frame = view["frames"][13]
    landmark = next(
        point for point in frame["landmarks"] if point["landmark_id"] == "right_hip"
    )
    payload["revisions"] = [
        {
            "contract_version": "1.0.0",
            "revision_id": "coordinates-edit",
            "expected_head": "coordinates-raw",
            "parent_revision_id": "coordinates-raw",
            "operation": "edit",
            "edits": [
                {
                    "view_id": view["view_id"],
                    "frame_index": frame["frame_index"],
                    "landmark": dict(
                        landmark, x=landmark["x"] + 8, source="manual_edit"
                    ),
                }
            ],
        }
    ]
    edited = invoke(payload)
    assert edited.returncode == 0, edited.stderr
    assert edited.stdout == invoke(payload).stdout
    output = json.loads(edited.stdout)
    assert (
        output["pose3d"]["provenance"]["coordinate_revision_id"] == "coordinates-edit"
    )
    before = baseline["pose3d"]["frames"][13]["landmarks"]
    after = output["pose3d"]["frames"][13]["landmarks"]
    hip_before, hip_after = (
        next(point for point in points if point["landmark_id"] == "right_hip")
        for points in (before, after)
    )
    assert hip_after["source"] == "manual_edit"
    assert abs(hip_after["x"] - hip_before["x"]) > 1e-5


@pytest.mark.parametrize("invalid", ["unit", "raw_id", "registry", "view_count"])
def test_cli_rejects_invalid_input(payload, invalid):
    if invalid == "unit":
        payload["views"][0]["unit"] = "m"
    elif invalid == "raw_id":
        payload["raw_revision_id"] = " "
    elif invalid == "registry":
        payload["evidence_registry_version"] = None
    else:
        payload["views"].pop()
    process = invoke(payload)
    assert process.returncode == 2
    assert not process.stdout
    assert json.loads(process.stderr) == {"error": "invalid_analysis_input"}
