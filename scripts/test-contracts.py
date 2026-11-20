from datetime import datetime
from itertools import pairwise
import json
import math
from pathlib import Path
import re
import sys

from jsonschema import Draft202012Validator, FormatChecker, ValidationError
from jsonschema.exceptions import best_match
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "packages" / "contracts"
EVIDENCE = ROOT / "docs" / "evidence"
DRAFT = "https://json-schema.org/draft/2020-12/schema"
EVIDENCE_URI = "https://sports-motion-app.invalid/evidence/evidence-record.schema.json"
ENTRY_POINTS = {
    "pose2d": ("pose-2d-sequence.schema.json", "#/$defs/Pose2DSequence"),
    "coordinate_revision": ("pose-2d-sequence.schema.json", "#/$defs/CoordinateRevision"),
    "calibration": ("calibration-params.schema.json", ""),
    "pose3d": ("pose-3d-sequence.schema.json", ""),
    "kinematic_metrics": ("kinematic-and-share-report.schema.json", "#/$defs/KinematicMetrics"),
    "share_report": ("kinematic-and-share-report.schema.json", "#/$defs/ShareReportSnapshot"),
}
FORMATS = FormatChecker()
DATE_TIME = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
    r"(?:\.(?P<fraction>[0-9]+))?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])",
    re.IGNORECASE,
)


@FORMATS.checks("date-time", raises=ValueError)
def check_datetime(value):
    if not isinstance(value, str):
        return True
    if not DATE_TIME.fullmatch(value):
        return False
    datetime.fromisoformat(value.upper())
    return True


def timestamp_key(value):
    # datetime keeps only microseconds, so retain the exact fraction for ties.
    fraction = DATE_TIME.fullmatch(value)["fraction"] or ""
    return datetime.fromisoformat(value.upper()), fraction.rstrip("0")


def reject_nonfinite(token):
    raise ValueError(f"Non-finite JSON number: {token}")


def parse_float(token):
    value = float(token)
    if not math.isfinite(value):
        reject_nonfinite(token)
    return value


def read_json(path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream, parse_constant=reject_nonfinite, parse_float=parse_float)


def load_schema(path):
    schema = read_json(path)
    if schema.get("$schema") != DRAFT:
        raise ValueError(f"{path.relative_to(ROOT)} must declare Draft 2020-12")
    Draft202012Validator.check_schema(schema)
    return schema


def validate_fixture(contract, validator, payload):
    error = best_match(validator.iter_errors(payload))
    if error is not None:
        raise error

    if contract in {"pose2d", "pose3d"}:
        for index, (previous, current) in enumerate(pairwise(payload["frames"]), start=1):
            for field in ("frame_index", "timestamp_sec"):
                if current[field] <= previous[field]:
                    raise ValidationError(f"{field} must strictly increase", path=["frames", index, field])

    if contract == "calibration" and payload["mode"] != "monocular_reference":
        first, second = payload["views"]
        if first["view_id"] == second["view_id"]:
            raise ValidationError("Calibration requires two distinct views", path=["views", 1, "view_id"])

    if contract == "share_report":
        if payload["analysis_revision_id"] != payload["kinematic_summary"]["analysis_revision_id"]:
            raise ValidationError(
                "Must reference the same analysis revision as the share report",
                path=["kinematic_summary", "analysis_revision_id"],
            )
        if timestamp_key(payload["expires_at"]) <= timestamp_key(payload["issued_at"]):
            raise ValidationError("expires_at must be after issued_at", path=["expires_at"])


def run():
    schemas = {path.name: load_schema(path) for path in sorted((CONTRACTS / "schemas").glob("*.json"))}
    evidence_schema = load_schema(EVIDENCE / "evidence-record.schema.json")
    resources = [(schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()]
    resources.append((EVIDENCE_URI, Resource.from_contents(evidence_schema)))
    registry = Registry().with_resources(resources)
    validators = {
        contract: Draft202012Validator(
            {"$ref": schemas[filename]["$id"] + fragment}, registry=registry, format_checker=FORMATS,
        )
        for contract, (filename, fragment) in ENTRY_POINTS.items()
    }
    print(f"PASS Draft 2020-12 meta-schema: {len(schemas)} contract schemas + evidence schema")

    catalog = read_json(EVIDENCE / "initial-literature-catalog.json")
    Draft202012Validator(evidence_schema, registry=registry, format_checker=FORMATS).validate(catalog)
    print(f"PASS initial-literature-catalog.json ({len(catalog['studies'])} studies)")

    failures = 0
    for group in ("valid", "invalid"):
        paths = sorted((CONTRACTS / "fixtures" / group).rglob("*.json"))
        if not paths:
            raise ValueError(f"No {group} fixtures found")
        passed = 0
        for path in paths:
            contract = path.name.split(".", 1)[0]
            if contract not in validators:
                raise ValueError(f"Unknown contract for {path.relative_to(ROOT)}")
            payload = read_json(path)
            try:
                validate_fixture(contract, validators[contract], payload)
            except ValidationError as error:
                if group == "valid":
                    print(f"FAIL {path.name} at {error.json_path}: {error.message}", file=sys.stderr)
                    failures += 1
                else:
                    print(f"PASS rejected {path.name} at {error.json_path}: {error.message}")
                    passed += 1
            else:
                if group == "invalid":
                    print(f"FAIL {path.name} was accepted", file=sys.stderr)
                    failures += 1
                else:
                    passed += 1
        print(f"{group}: {passed}/{len(paths)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
