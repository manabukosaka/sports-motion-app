import argparse
import importlib.metadata
import json
import math
import os
import platform
import shlex
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter

import numpy as np
from jsonschema import Draft202012Validator, FormatChecker
from motion_engine.contracts import Contract, DLTCalibration, StereoCalibration
from motion_engine.filtering import FilterSettings, butterworth_lowpass
from motion_engine.kinematics import LANDING_EVENTS, METRICS
from motion_engine.pipeline import PipelineResult, run_calibrated_pipeline
from referencing import Registry, Resource

if __package__:
    from .synthetic import (
        DATASET_VERSION,
        FPS,
        IMAGE_SIZE,
        NOISE_SD_PX,
        OCCLUSION_FRAMES,
        SEED,
        MotionCase,
        fit_calibrations,
        raised_cosine_pulse,
        synthetic_motion,
        virtual_rig,
    )
else:
    from synthetic import (
        DATASET_VERSION,
        FPS,
        IMAGE_SIZE,
        NOISE_SD_PX,
        OCCLUSION_FRAMES,
        SEED,
        MotionCase,
        fit_calibrations,
        raised_cosine_pulse,
        synthetic_motion,
        virtual_rig,
    )

ROOT = Path(__file__).resolve().parents[2]
BASELINE = Path(__file__).with_name("baseline.json")
EVIDENCE_URI = "https://sports-motion-app.invalid/evidence/evidence-record.schema.json"
COMMAND = (
    "uv run --project services/motion-engine python evals/biomechanics/run_eval.py"
)


def schema_validators() -> dict[str, Draft202012Validator]:
    directory = ROOT / "packages" / "contracts" / "schemas"
    schemas = {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in directory.glob("*.json")
    }
    evidence = json.loads(
        (ROOT / "docs/evidence/evidence-record.schema.json").read_text(encoding="utf-8")
    )
    for schema in [*schemas.values(), evidence]:
        if schema["$schema"] != Draft202012Validator.META_SCHEMA["$id"]:
            raise ValueError("expected Draft 2020-12")
        Draft202012Validator.check_schema(schema)
    registry = Registry().with_resources(
        [
            *(
                (schema["$id"], Resource.from_contents(schema))
                for schema in schemas.values()
            ),
            (EVIDENCE_URI, Resource.from_contents(evidence)),
        ]
    )
    definitions = {
        "calibration": ("calibration-params.schema.json", ""),
        "pose2d": ("pose-2d-sequence.schema.json", "#/$defs/Pose2DSequence"),
        "revision": ("pose-2d-sequence.schema.json", "#/$defs/CoordinateRevision"),
        "pose3d": ("pose-3d-sequence.schema.json", ""),
        "kinematics": (
            "kinematic-and-share-report.schema.json",
            "#/$defs/KinematicMetrics",
        ),
    }
    return {
        name: Draft202012Validator(
            {"$ref": schemas[filename]["$id"] + fragment},
            registry=registry,
            format_checker=FormatChecker(),
        )
        for name, (filename, fragment) in definitions.items()
    }


def validate_payload(validator: Draft202012Validator, payload: Contract) -> None:
    validator.validate(payload.model_dump(mode="json", exclude_unset=True))


def cpu_model() -> str:
    if os.name == "nt":
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"
        ) as key:
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
    if sys.platform == "darwin":
        return subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
        ).strip()
    path = Path("/proc/cpuinfo")
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition(":")
            if name.strip() == "model name":
                return value.strip()
    return platform.processor() or platform.machine()


@dataclass(frozen=True)
class Gate:
    name: str
    measured: float
    comparison: str
    limit: float

    @property
    def passed(self) -> bool:
        if not math.isfinite(self.measured):
            return False
        return {
            "<": self.measured < self.limit,
            "==": self.measured == self.limit,
            ">": self.measured > self.limit,
            "<=": self.measured <= self.limit,
        }[self.comparison]


def recompute(
    case: MotionCase,
    calibration: DLTCalibration | StereoCalibration,
    *,
    pooled: bool = False,
) -> PipelineResult:
    return run_calibrated_pipeline(
        case.raw,
        calibration,
        movement=case.movement,
        analysis_revision_id=f"{case.movement}-{calibration.calibration_id}",
        raw_revision_id="coordinates-raw",
        revisions=(case.edit,),
        events=case.events,
        filter_settings=FilterSettings(band_separated=not pooled),
    )


def peak_extension(angles_deg: np.ndarray, time_sec: np.ndarray) -> tuple[float, int]:
    rates = -np.gradient(angles_deg, time_sec)
    peak = int(np.argmax(rates))
    return float(rates[peak]), peak


def finite_metrics(
    result: PipelineResult, case: MotionCase
) -> tuple[float, float, float]:
    predicted = result.angle_series_deg
    if predicted.shape != case.angle_deg.shape or not np.isfinite(predicted).all():
        raise ValueError(f"{case.movement}: invalid or incomplete angle series")
    spec = METRICS[case.movement]
    primary_waveforms = [
        wave
        for wave in result.metrics.normalized_waveforms
        if wave.metric_id == spec.metric_id and wave.side == "right"
    ]
    if result.pose.bone_length_stability_mm is None or len(primary_waveforms) != 1:
        raise ValueError(
            f"{case.movement}: expected bone length and normalized waveform"
        )
    required_events = {
        event.event_id
        for event in case.events
        if case.movement not in LANDING_EVENTS
        or event.event_id in LANDING_EVENTS[case.movement]
    }
    required = {(spec.metric_id, event) for event in required_events}
    if case.movement == "baseball_pitching":
        required.add(("pitch_elbow_peak_extension_angular_velocity", "pitch_cycle"))
    measured = {
        (metric.metric_id, metric.event_id)
        for metric in result.metrics.scalar_metrics
        if metric.value_or_null is not None and metric.side == "right"
    }
    if not required <= measured:
        raise ValueError(f"{case.movement}: unexpected missing event metric")
    if not all(
        any(
            point.source == "spline_interpolated"
            for point in result.pose.frames[index].landmarks
        )
        for index in OCCLUSION_FRAMES
    ):
        raise ValueError(f"{case.movement}: occlusion gap was not interpolated")
    error = float(np.sqrt(np.mean((predicted - case.angle_deg) ** 2)))
    correlation = float(np.corrcoef(predicted, case.angle_deg)[0, 1])
    return error, correlation, result.pose.bone_length_stability_mm


def run(command: str) -> tuple[dict, bool]:
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    if baseline["dataset_version"] != DATASET_VERSION:
        raise ValueError("baseline and synthetic dataset versions differ")
    rig = virtual_rig()
    calibrations = fit_calibrations(rig)
    cases = [synthetic_motion(movement, rig) for movement in FPS]
    long_case = synthetic_motion("baseball_pitching", rig, frame_count=720)
    validators = schema_validators()
    payload_count = 0

    def check(name: str, payload: Contract) -> None:
        nonlocal payload_count
        validate_payload(validators[name], payload)
        payload_count += 1

    for case in [*cases, long_case]:
        for view in case.raw:
            check("pose2d", view)
        check("revision", case.edit)

    metadata = {
        "dataset": "three-motion synthetic two-camera rig",
        "dataset_version": DATASET_VERSION,
        "seed": SEED,
        "cpu": cpu_model(),
        "logical_cpus": os.cpu_count(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "dependencies": {
            name: importlib.metadata.version(name)
            for name in (
                "numpy",
                "scipy",
                "opencv-python-headless",
                "pydantic",
                "jsonschema",
            )
        },
        "command": command,
        "cameras": len(rig.views),
        "resolution_px": IMAGE_SIZE,
        "noise_sd_px": NOISE_SD_PX,
        "occlusion_frames": OCCLUSION_FRAMES,
        "control_pole_fit_and_check_points": [16, 8],
        "checkerboard_fit_and_check_poses": [7, 2],
        "checkerboard_corners_per_pose": 54,
        "recompute_frames": 720,
        "samples": {
            case.movement: {"frames": len(case.time_sec), "fps": case.fps}
            for case in cases
        },
    }
    print("Biomechanics eval metadata")
    print(json.dumps(metadata, sort_keys=True))

    gates = []
    observations = []
    for calibration in calibrations:
        method = "DLT" if isinstance(calibration, DLTCalibration) else "Stereo"
        check("calibration", calibration)
        gates.append(
            Gate(
                f"{method} held-out reprojection (px)",
                calibration.held_out_check.reprojection_error_px,
                "<",
                baseline["held_out_reprojection_px_lt"],
            )
        )
        if isinstance(calibration, DLTCalibration):
            gates.append(
                Gate(
                    "DLT known-distance RMSE (m)",
                    calibration.held_out_check.known_distance_rmse_m,
                    "<",
                    baseline["dlt_known_distance_rmse_m_lt"],
                )
            )
        for case in cases:
            result = recompute(case, calibration)
            check("pose3d", result.pose)
            check("kinematics", result.metrics)
            rmse, correlation, bone_sd = finite_metrics(result, case)
            observations.append(
                {
                    "motion": case.movement,
                    "method": method,
                    "metric_id": METRICS[case.movement].metric_id,
                    "ground_truth": f"synthetic.py:{case.movement}@{DATASET_VERSION}/seed-{SEED}",
                    "angle_rmse_deg": rmse,
                    "angle_correlation": correlation,
                    "bone_length_sd_mm": bone_sd,
                    "filter_settings": asdict(result.filter_settings),
                    "cutoffs_hz": result.selected_cutoffs_hz,
                    "provenance": result.metrics.provenance.model_dump(mode="json"),
                    "plugin_versions": {
                        manifest.stage: manifest.plugin_version
                        for manifest in result.stage_manifests
                    },
                }
            )
            gates.extend(
                [
                    Gate(
                        f"{method} {case.movement} angle RMSE (deg)",
                        rmse,
                        "<",
                        baseline["worst_angle_rmse_deg_lt"],
                    ),
                    Gate(
                        f"{method} {case.movement} bone-length SD (mm)",
                        bone_sd,
                        "<",
                        baseline["bone_length_sd_mm_lt"],
                    ),
                ]
            )
            if case.movement == "baseball_pitching":
                pooled = recompute(case, calibration, pooled=True)
                check("pose3d", pooled.pose)
                check("kinematics", pooled.metrics)
                finite_metrics(pooled, case)
                actual, actual_frame = peak_extension(case.angle_deg, case.time_sec)
                upper, upper_frame = peak_extension(
                    result.angle_series_deg, case.time_sec
                )
                pooled_peak, pooled_frame = peak_extension(
                    pooled.angle_series_deg, case.time_sec
                )
                pooled_attenuation = max(0.0, 1 - pooled_peak / actual)
                upper_attenuation = max(0.0, 1 - upper / actual)
                relative_error = abs(upper - actual) / actual
                attenuation_gain = min(
                    pooled_attenuation - upper_attenuation,
                    abs(pooled_peak - actual) / actual - relative_error,
                )
                observations[-1]["peak_extension"] = {
                    "truth_deg_per_s": actual,
                    "separated_deg_per_s": upper,
                    "pooled_deg_per_s": pooled_peak,
                    "truth_frame": actual_frame,
                    "separated_frame": upper_frame,
                    "pooled_frame": pooled_frame,
                    "pooled_cutoff_hz": pooled.selected_cutoffs_hz["pooled"],
                }
                gates.extend(
                    [
                        Gate(
                            f"{method} upper-limb peak relative error",
                            relative_error,
                            "<",
                            baseline["upper_peak_relative_error_lt"],
                        ),
                        Gate(
                            f"{method} upper-limb attenuation improvement vs pooled",
                            attenuation_gain,
                            ">",
                            baseline["upper_peak_attenuation_improvement_gt"],
                        ),
                        Gate(
                            f"{method} upper-limb peak timing error (frames)",
                            abs(upper_frame - actual_frame),
                            "<=",
                            baseline["upper_peak_timing_error_frames_lte"],
                        ),
                    ]
                )
        start = perf_counter()
        benchmark = recompute(long_case, calibration)
        latency_ms = (perf_counter() - start) * 1000
        check("pose3d", benchmark.pose)
        check("kinematics", benchmark.metrics)
        finite_metrics(benchmark, long_case)
        gates.append(
            Gate(
                f"{method} 720-frame recompute (ms)",
                latency_ms,
                "<",
                baseline["recompute_720_frames_ms_lt"],
            )
        )

    pulse = raised_cosine_pulse()
    filtered = butterworth_lowpass(pulse, 240, 24)
    phase_shift = abs(int(np.argmax(filtered)) - int(np.argmax(pulse)))
    gates.append(
        Gate(
            "Clean zero-phase peak shift (frames)",
            phase_shift,
            "==",
            baseline["zero_phase_shift_frames_eq"],
        )
    )
    print(f"PASS Draft 2020-12 validation ({payload_count} payloads)")
    print()
    print("| Gate | Measured | Limit | Result |")
    print("| --- | ---: | ---: | :---: |")
    for gate in gates:
        measured = (
            f"{gate.measured:.6g}"
            if 0 < abs(gate.measured) < 1e-4
            else f"{gate.measured:.6f}"
        )
        print(
            f"| {gate.name} | {measured} | {gate.comparison} {gate.limit:g} | "
            f"{'PASS' if gate.passed else 'FAIL'} |"
        )
    passed = sum(gate.passed for gate in gates)
    print(f"Biomechanics gates: {passed}/{len(gates)} passed")
    return {
        "metadata": metadata,
        "validated_payloads": payload_count,
        "observations": observations,
        "gates": [{**asdict(gate), "passed": gate.passed} for gate in gates],
    }, passed == len(gates)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the deterministic synthetic biomechanics regression."
    )
    parser.add_argument("--json-out", type=Path)
    options = parser.parse_args()
    command = COMMAND
    if options.json_out is not None:
        command += f" --json-out {shlex.quote(str(options.json_out))}"
    report, passed = run(command)
    if options.json_out is not None:
        options.json_out.write_text(
            json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
