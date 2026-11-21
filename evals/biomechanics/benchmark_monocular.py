import argparse
import json
import platform
import sys
from contextlib import closing
from math import cos, sin, tau
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Literal

import cv2
import numpy as np
from jsonschema import ValidationError as SchemaError
from motion_engine import (
    MEDIAPIPE_LANDMARK_IDS,
    MediaPipeWorldLandmark,
    build_mediapipe_plugin_manifest,
)
from motion_engine.cli import VideoAnalyzeRequest, analyze
from motion_engine.contracts import (
    CaptureEvent,
    CaptureEventID,
    MonocularReferenceCalibration,
)
from motion_engine.monocular import iter_video_frames, read_video_metadata
from motion_engine.pipeline import CONTRACT_VERSION
from motion_engine.plugins import LicenseAttestation
from numpy.typing import NDArray

FPS = 60
FRAME_COUNT = 10 * FPS
RESOLUTION = (640, 360)
P95_LIMIT_SEC = 60.0
DATASET = "synthetic-running-silhouette-v1"


def runner_landmarks(timestamp_ms: int) -> list[MediaPipeWorldLandmark]:
    phase = tau * timestamp_ms / 1000
    points = {
        "nose": (0.00, -0.69, 0.08),
        "left_eye_inner": (0.02, -0.72, 0.07),
        "left_eye": (0.03, -0.72, 0.07),
        "left_eye_outer": (0.04, -0.72, 0.06),
        "right_eye_inner": (-0.02, -0.72, 0.07),
        "right_eye": (-0.03, -0.72, 0.07),
        "right_eye_outer": (-0.04, -0.72, 0.06),
        "left_ear": (0.08, -0.69, 0.00),
        "right_ear": (-0.08, -0.69, 0.00),
        "left_mouth": (0.03, -0.65, 0.07),
        "right_mouth": (-0.03, -0.65, 0.07),
    }
    for side, sign in (("left", 1), ("right", -1)):
        swing = sign * sin(phase)
        thigh = 0.6 * swing
        shank = thigh - (0.65 - sign * 0.5 * cos(phase))
        knee_y, knee_z = 0.42 * cos(thigh), 0.42 * sin(thigh)
        ankle_y = knee_y + 0.42 * cos(shank)
        ankle_z = knee_z + 0.42 * sin(shank)
        wrist_z = -0.14 * swing + 0.19
        points.update(
            {
                f"{side}_shoulder": (sign * 0.20, -0.51, 0.01),
                f"{side}_elbow": (sign * 0.24, -0.26, -0.14 * swing),
                f"{side}_wrist": (sign * 0.25, -0.31, wrist_z),
                f"{side}_pinky": (sign * 0.27, -0.32, wrist_z + 0.06),
                f"{side}_index": (sign * 0.25, -0.32, wrist_z + 0.07),
                f"{side}_thumb": (sign * 0.23, -0.33, wrist_z + 0.05),
                f"{side}_hip": (sign * 0.13, 0.0, 0.0),
                f"{side}_knee": (sign * 0.14, knee_y, knee_z),
                f"{side}_ankle": (sign * 0.14, ankle_y, ankle_z),
                f"{side}_heel": (sign * 0.14, ankle_y + 0.04, ankle_z - 0.04),
                f"{side}_foot_index": (sign * 0.14, ankle_y + 0.04, ankle_z + 0.13),
            }
        )
    return [
        MediaPipeWorldLandmark(*points[name], visibility=1.0, presence=1.0)
        for name in MEDIAPIPE_LANDMARK_IDS
    ]


def synthetic_backend(
    rgb_frame: NDArray[np.uint8], timestamp_ms: int, /
) -> list[MediaPipeWorldLandmark]:
    return runner_landmarks(timestamp_ms)


def write_synthetic_video(path: Path, frame_count: int = FRAME_COUNT) -> None:
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, RESOLUTION
    )
    try:
        if not writer.isOpened():
            raise RuntimeError("OpenCV could not open the benchmark video writer")
        for index in range(frame_count):
            time = index / FPS
            landmarks = runner_landmarks(round(time * 1000))
            travel = 46 * sin(tau * time / 5.0)
            bob = 6 * cos(2 * tau * time)
            pixels = {
                name: (
                    round(320 + travel + 151 * (0.65 * point.x + 0.76 * point.z)),
                    round(164 + bob + 151 * point.y),
                )
                for name, point in zip(MEDIAPIPE_LANDMARK_IDS, landmarks, strict=True)
            }
            frame = np.full(
                (RESOLUTION[1], RESOLUTION[0], 3), (216, 228, 240), np.uint8
            )
            cv2.line(frame, (0, 309), (RESOLUTION[0] - 1, 309), (132, 157, 169), 2)
            for side, color in (("right", (53, 75, 112)), ("left", (39, 55, 89))):
                for start, end, width in (
                    ("shoulder", "hip", 25),
                    ("shoulder", "elbow", 13),
                    ("elbow", "wrist", 11),
                    ("hip", "knee", 16),
                    ("knee", "ankle", 13),
                    ("heel", "foot_index", 9),
                ):
                    cv2.line(
                        frame,
                        pixels[f"{side}_{start}"],
                        pixels[f"{side}_{end}"],
                        color,
                        width,
                        cv2.LINE_AA,
                    )
            cv2.circle(frame, pixels["nose"], 17, (56, 82, 122), -1, cv2.LINE_AA)
            writer.write(frame)
    finally:
        writer.release()


def write_synthetic_plugin(directory: Path) -> tuple[Path, Path]:
    model_path = directory / "synthetic.task"
    model_path.write_bytes(DATASET.encode("ascii"))
    manifest_path = directory / "synthetic.manifest.json"
    manifest = build_mediapipe_plugin_manifest(
        model_path,
        license_attestation=LicenseAttestation(
            attested_by="sports-motion-app",
            rights_evidence="First-party synthetic benchmark fixture",
            intended_use="benchmark",
        ),
    )
    manifest_path.write_text(manifest.model_dump_json(), encoding="utf-8")
    return model_path, manifest_path


def running_events(video_path: Path) -> list[CaptureEvent]:
    schedule: dict[int, CaptureEventID] = {
        0: "run_initial_contact",
        FPS // 3: "run_toe_off",
        FPS: "run_next_initial_contact",
    }
    with closing(iter_video_frames(video_path)) as frames:
        return [
            CaptureEvent(
                event_id=schedule[frame.frame_index],
                frame_index=frame.frame_index,
                timestamp_sec=frame.timestamp_sec,
                detection_mode="manual",
                side="right",
            )
            for frame in frames
            if frame.frame_index in schedule
        ]


def benchmark(runs: int, model: tuple[Path, Path] | None = None) -> dict[str, object]:
    mode: Literal["synthetic", "mediapipe"] = "synthetic"
    with TemporaryDirectory(prefix="motion-benchmark-") as temp:
        directory = Path(temp)
        video_path = directory / "running.avi"
        write_synthetic_video(video_path)
        metadata = read_video_metadata(video_path)
        if (
            metadata.frame_count,
            metadata.fps,
            metadata.width_px,
            metadata.height_px,
        ) != (FRAME_COUNT, FPS, *RESOLUTION):
            raise RuntimeError(f"unexpected benchmark video metadata: {metadata}")
        if model is None:
            model_path, manifest_path = write_synthetic_plugin(directory)
        else:
            mode = "mediapipe"
            model_path, manifest_path = model
        request = VideoAnalyzeRequest(
            video_path=str(video_path),
            calibration=MonocularReferenceCalibration(
                contract_version=CONTRACT_VERSION,
                calibration_id="benchmark-reference",
                mode="monocular_reference",
                view_id="benchmark-video",
            ),
            model_path=str(model_path),
            manifest_path=str(manifest_path),
            movement="running",
            analysis_revision_id="benchmark-running",
            raw_revision_id="coordinates-raw",
            events=running_events(video_path),
        )
        latencies = []
        pelvis_frame_counts = []
        for _ in range(runs):
            start = perf_counter()
            payload = json.dumps(
                analyze(
                    request,
                    video_backend=synthetic_backend if mode == "synthetic" else None,
                ),
                allow_nan=False,
            )
            latencies.append(perf_counter() - start)
            frames = json.loads(payload)["pose3d"]["frames"]
            if len(frames) != FRAME_COUNT:
                raise RuntimeError(
                    f"benchmark decoded {len(frames)} of {FRAME_COUNT} frames"
                )
            pelvis_frame_counts.append(
                sum(
                    any(
                        point["landmark_id"] == "pelvis"
                        and point["missing_reason"] is None
                        for point in frame["landmarks"]
                    )
                    for frame in frames
                )
            )
    p50, p95 = map(float, np.percentile(latencies, [50, 95]))
    return {
        "mode": mode,
        "dataset": DATASET,
        "frame_count": FRAME_COUNT,
        "fps": FPS,
        "resolution": list(RESOLUTION),
        "runs": runs,
        "python_version": platform.python_version(),
        "opencv_version": cv2.__version__,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "p50_sec": p50,
        "p95_sec": p95,
        "min_sec": min(latencies),
        "max_sec": max(latencies),
        "effective_fps": FRAME_COUNT / p50,
        "frames_with_visible_pelvis": pelvis_frame_counts,
        "p95_limit_sec": P95_LIMIT_SEC,
        "passed": p95 <= P95_LIMIT_SEC,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark 600-frame monocular analysis."
    )
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--mediapipe-model", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    if (args.mediapipe_model is None) != (args.manifest is None):
        parser.error("--mediapipe-model and --manifest must be supplied together")
    model = (args.mediapipe_model, args.manifest) if args.mediapipe_model else None
    try:
        result = benchmark(args.runs, model)
    except (OSError, RuntimeError, SchemaError, ValueError) as error:
        print(f"Benchmark failed: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, allow_nan=False))
    else:
        for key, value in result.items():
            print(f"{key}: {value}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
