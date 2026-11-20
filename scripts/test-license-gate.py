import argparse
import json
import re
import sys
import tomllib
from collections import defaultdict
from pathlib import Path
from typing import Any

PROJECT = Path(__file__).resolve().parents[1] / "services" / "motion-engine"
PYPI = {"registry": "https://pypi.org/simple"}
FORBIDDEN = {"chumpy", "mmpose", "rtmlib", "smplx", "ultralytics"}
APPROVED_LICENSES = {
    "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "PSF-2.0",
}


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def check_name(name: str) -> None:
    if name in FORBIDDEN:
        raise ValueError(f"Forbidden Tier A runtime dependency: {name}")


def check_declarations(requirements: list[str], edges: list[dict[str, Any]]) -> None:
    locked = {normalize(edge["name"]) for edge in edges}
    declared = set()
    for requirement in requirements:
        match = re.match(r"\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)", requirement)
        if match is None:
            raise ValueError(f"Invalid runtime dependency declaration: {requirement!r}")
        declared.add(normalize(match[1]))
    for name in sorted(locked | declared):
        check_name(name)
    if declared != locked:
        raise ValueError(
            f"Runtime declarations differ from uv.lock: missing {sorted(declared - locked)}, "
            f"unexpected {sorted(locked - declared)}"
        )


def check_runtime(project: dict[str, Any], lock: dict[str, Any], allowlist: dict[str, Any]) -> int:
    if lock["version"] != 1 or allowlist["schema_version"] != 1:
        raise ValueError("Unsupported lockfile or Tier A allowlist format")

    approvals = set()
    for approval in allowlist["packages"]:
        name = normalize(approval["name"])
        version = approval["version"]
        key = (name, version)
        check_name(name)
        if key in approvals:
            raise ValueError(f"Duplicate Tier A approval: {name}=={version}")
        rationale = approval["rationale"]
        if (
            approval["license"] not in APPROVED_LICENSES
            or not isinstance(rationale, str)
            or not rationale.strip()
        ):
            raise ValueError(f"Invalid Tier A license or rationale: {name}=={version}")
        approvals.add(key)

    packages = defaultdict(list)
    for package in lock["package"]:
        packages[normalize(package["name"])].append(package)

    roots = [
        package for package in packages[normalize(project["name"])]
        if package["source"] in ({"editable": "."}, {"virtual": "."})
    ]
    if len(roots) != 1:
        raise ValueError("Expected one local motion-engine package in uv.lock")
    root = roots[0]
    pending = list(root.get("dependencies", []))
    optional = root.get("optional-dependencies", {})
    declared_optional = {
        normalize(extra): requirements
        for extra, requirements in project.get("optional-dependencies", {}).items()
    }
    check_declarations(project.get("dependencies", []), pending)
    for extra in sorted(optional.keys() | declared_optional.keys()):
        edges = optional.get(extra, [])
        check_declarations(declared_optional.get(extra, []), edges)
        pending.extend(edges)

    visited = set()
    # Visit every locked marker branch, including ones inactive on this runner.
    while pending:
        edge = pending.pop()
        name = normalize(edge["name"])
        check_name(name)
        matches = [
            package for package in packages[name]
            if all(package[field] == edge[field] for field in ("version", "source") if field in edge)
        ]
        if len(matches) != 1:
            raise ValueError(f"Expected one locked release for runtime dependency {edge}")
        package = matches[0]
        version = package["version"]
        key = (name, version)
        if package["source"] != PYPI or key not in approvals:
            raise ValueError(f"Unapproved Tier A runtime dependency: {name}=={version} ({package['source']})")
        extras = frozenset(edge.get("extra", []))
        visit = (key, extras)
        if visit in visited:
            continue
        visited.add(visit)
        pending.extend(package.get("dependencies", []))
        for extra in sorted(extras):
            pending.extend(package.get("optional-dependencies", {}).get(extra, []))

    return len({key for key, _ in visited})


def self_test() -> None:
    cases = [
        ("forbidden declaration", "ultralytics", "Forbidden"),
        ("forbidden transitive dependency", "ultralytics", "Forbidden"),
        ("unapproved transitive dependency", "unapproved-package", "Unapproved"),
    ]
    allowlist = {
        "schema_version": 1,
        "packages": [{"name": "fixture-parent", "version": "1.0", "license": "MIT", "rationale": "Self-test"}],
    }
    for case, name, expected in cases:
        requirements = ["fixture-parent"]
        dependencies: list[dict[str, str]] = []
        root = {"name": "motion-engine", "source": {"editable": "."}, "dependencies": [{"name": "fixture-parent"}]}
        parent = {"name": "fixture-parent", "version": "1.0", "source": PYPI, "dependencies": dependencies}
        packages: list[dict[str, Any]] = [root, parent]
        if case == "forbidden declaration":
            requirements.append("Ultralytics[export]>=1; python_version < '3.13'")
        else:
            dependencies.append({"name": name, "marker": "sys_platform == 'win32'"})
            packages.append({"name": name, "version": "1.0", "source": PYPI})
        project = {"name": "motion-engine", "dependencies": requirements}
        lock = {"version": 1, "package": packages}
        try:
            check_runtime(project, lock, allowlist)
        except ValueError as error:
            if not str(error).startswith(f"{expected} Tier A runtime dependency: {name}"):
                raise RuntimeError(f"Self-test {case} failed with unexpected error: {error}") from error
            print(f"PASS self-test ({case}): {error}")
        else:
            raise RuntimeError(f"Self-test {case} unexpectedly passed the license gate")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the motion-engine Tier A runtime allowlist.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        project = tomllib.loads((PROJECT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
        lock = tomllib.loads((PROJECT / "uv.lock").read_text(encoding="utf-8"))
        allowlist = json.loads((PROJECT / "tier-a-allowlist.json").read_text(encoding="utf-8"))
        approved = check_runtime(project, lock, allowlist)
        print(f"PASS Tier A license gate: {approved} approved runtime package releases")
        if args.self_test:
            self_test()
    except (KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
        print(f"FAIL Tier A license gate: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
