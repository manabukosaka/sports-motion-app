import argparse
import json
import sys
from functools import cache
from pathlib import Path
from typing import Annotated, Literal

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from jsonschema import ValidationError as SchemaError
from pydantic import Field, ValidationError
from referencing import Registry, Resource

from .contracts import (
    CaptureEvent,
    Contract,
    CoordinateRevision,
    DLTCalibration,
    Movement,
    NonBlank,
    Pose2DSequence,
    SemVer,
    StereoCalibration,
)
from .pipeline import run_calibrated_pipeline

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = ROOT / "docs/evidence"


@cache
def evidence_policy() -> tuple[str, str]:
    catalog = json.loads(
        (EVIDENCE / "initial-literature-catalog.json").read_text(encoding="utf-8")
    )
    return catalog["evidence_registry_version"], catalog["disclaimer_policy"][
        "user_facing_text_ja"
    ]


class AnalyzeRequest(Contract):
    views: tuple[Pose2DSequence, Pose2DSequence]
    calibration: Annotated[
        DLTCalibration | StereoCalibration, Field(discriminator="mode")
    ]
    movement: Literal["baseball_pitching", "running", "jump_landing"]
    analysis_revision_id: NonBlank
    raw_revision_id: NonBlank
    revisions: list[CoordinateRevision] = Field(default_factory=list)
    events: list[CaptureEvent] = Field(default_factory=list)
    evidence_registry_version: SemVer = Field(
        default_factory=lambda: evidence_policy()[0]
    )


@cache
def output_validators() -> tuple[Draft202012Validator, Draft202012Validator]:
    schemas = {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in (ROOT / "packages/contracts/schemas").glob("*.json")
    }
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    evidence_schema = json.loads(
        (EVIDENCE / "evidence-record.schema.json").read_text(encoding="utf-8")
    )
    registry = registry.with_resource(
        "https://sports-motion-app.invalid/evidence/evidence-record.schema.json",
        Resource.from_contents(evidence_schema),
    )
    return (
        Draft202012Validator(
            schemas["pose-3d-sequence.schema.json"], registry=registry
        ),
        Draft202012Validator(
            {
                "$ref": schemas["kinematic-and-share-report.schema.json"]["$id"]
                + "#/$defs/KinematicMetrics"
            },
            registry=registry,
        ),
    )


class InvalidAnalysisInput(ValueError):
    pass


def analyze(request: AnalyzeRequest) -> dict[str, object]:
    movement: Movement
    if request.movement == "jump_landing":
        has_drop_jump = any(
            event.event_id.startswith("dvj_") for event in request.events
        )
        if has_drop_jump and any(
            event.event_id.startswith("cmj_") for event in request.events
        ):
            raise InvalidAnalysisInput("jump events must describe one movement")
        movement = "dvj" if has_drop_jump else "cmj"
    else:
        movement = request.movement
    try:
        result = run_calibrated_pipeline(
            request.views,
            request.calibration,
            movement=movement,
            analysis_revision_id=request.analysis_revision_id,
            raw_revision_id=request.raw_revision_id,
            revisions=request.revisions,
            events=request.events,
        )
    except ValidationError as error:
        raise RuntimeError("Pipeline produced an invalid contract") from error
    except ValueError as error:
        raise InvalidAnalysisInput(str(error)) from error
    pose = result.pose.model_dump(mode="json")
    metrics = result.metrics.model_dump(mode="json")
    pose_validator, metrics_validator = output_validators()
    pose_validator.validate(pose)
    metrics_validator.validate(metrics)
    return {
        "pose3d": pose,
        "kinematic_metrics": metrics,
        "selected_cutoffs_hz": result.selected_cutoffs_hz,
        "evidence_registry_version": request.evidence_registry_version,
        "non_diagnostic_flag": True,
        "disclaimer_text_ja": evidence_policy()[1],
        "evidence_comparisons": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["analyze"])
    parser.parse_args()
    try:
        result = analyze(AnalyzeRequest.model_validate_json(sys.stdin.buffer.read()))
        print(json.dumps(result, allow_nan=False))
    except (ValidationError, InvalidAnalysisInput):
        print(json.dumps({"error": "invalid_analysis_input"}), file=sys.stderr)
        return 2
    except (ValueError, RuntimeError, SchemaError):
        print(json.dumps({"error": "analysis_failed"}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
