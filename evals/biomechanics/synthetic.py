from dataclasses import dataclass
from itertools import product

import cv2
import numpy as np
from motion_engine.calibration import (
    BoardObservation,
    FloatArray,
    StereoPair,
    camera_matrix,
    fit_dlt_calibration,
    fit_stereo_calibration,
)
from motion_engine.contracts import (
    CaptureEvent,
    CoordinateEdit,
    CoordinateRevision,
    DLTCalibration,
    Frame,
    Intrinsics,
    Landmark2D,
    Movement,
    Pose2DSequence,
    StereoCalibration,
    StereoView,
)
from motion_engine.kinematics import METRICS
from motion_engine.pipeline import CONTRACT_VERSION
from scipy.spatial.transform import Rotation
from scipy.special import ndtr

SEED = 35
IMAGE_SIZE = (1920, 1080)
NOISE_SD_PX = 0.55
OCCLUSION_FRAMES = (84, 85, 86)
DATASET_VERSION = "1.0.0"


@dataclass(frozen=True)
class Rig:
    views: StereoPair
    rotations: tuple[FloatArray, FloatArray]
    translations_m: tuple[FloatArray, FloatArray]

    def project(self, world_m: FloatArray, camera_index: int) -> FloatArray:
        view = self.views[camera_index]
        shape = world_m.shape
        pixels, _ = cv2.projectPoints(
            world_m.reshape(-1, 3),
            self.rotations[camera_index],
            self.translations_m[camera_index],
            camera_matrix(view),
            np.asarray(view.distortion_coefficients),
        )
        return pixels.reshape(*shape[:-1], 2)


def virtual_rig() -> Rig:
    views = (
        StereoView(
            view_id="first",
            intrinsics=Intrinsics(fx_px=1480, fy_px=1490, cx_px=955, cy_px=538),
            distortion_coefficients=[-0.18, 0.055, 0.001, -0.0015, 0.008],
        ),
        StereoView(
            view_id="second",
            intrinsics=Intrinsics(fx_px=1455, fy_px=1475, cx_px=965, cy_px=543),
            distortion_coefficients=[-0.14, 0.04, -0.0008, 0.001, 0.005],
        ),
    )
    rotation = Rotation.from_euler("y", 11, degrees=True).as_matrix()
    return Rig(
        views,
        (np.eye(3), rotation),
        (np.array([0.0, 0.0, 4.8]), rotation @ np.array([-1.05, 0.04, 4.8])),
    )


def fit_calibrations(rig: Rig) -> tuple[DLTCalibration, StereoCalibration]:
    controls = np.array(
        list(product((-1.0, 0.95), (-0.9, 1.0), (-0.45, -0.1, 0.3, 0.65)))
    )
    checks = np.array(list(product((-0.72, 0.65), (-0.68, 0.75), (-0.28, 0.52))))
    dlt = fit_dlt_calibration(
        "synthetic-dlt",
        CONTRACT_VERSION,
        rig.views,
        controls,
        (rig.project(controls, 0), rig.project(controls, 1)),
        checks,
        (rig.project(checks, 0), rig.project(checks, 1)),
    )

    observations = stereo_board_observations(rig)
    stereo = fit_stereo_calibration(
        "synthetic-stereo",
        CONTRACT_VERSION,
        rig.views,
        IMAGE_SIZE,
        observations[:7],
        observations[7:],
    )
    return dlt, stereo


def stereo_board_observations(rig: Rig) -> list[BoardObservation]:
    board = np.array(list(product(np.arange(9) * 0.08, np.arange(6) * 0.08, (0.0,))))
    board -= board.mean(axis=0)
    observations = []
    for index in range(9):
        roll = (-1) ** index * (8 + index * 2)
        rotation = Rotation.from_euler(
            "xyz", (roll, 7 * (index - 4), index * 9), degrees=True
        )
        position = np.array(
            [0.13 * (index - 4), 0.2 * (index % 3 - 1), -0.4 + 0.16 * index]
        )
        world = rotation.apply(board) + position
        observations.append(
            BoardObservation(board, rig.project(world, 0), rig.project(world, 1))
        )
    return observations


@dataclass(frozen=True)
class MotionCase:
    movement: Movement
    fps: int
    time_sec: FloatArray
    angle_deg: FloatArray
    world_m: dict[str, FloatArray]
    raw: tuple[Pose2DSequence, Pose2DSequence]
    events: tuple[CaptureEvent, ...]
    edit: CoordinateRevision


FPS: dict[Movement, int] = {"baseball_pitching": 240, "running": 120, "dvj": 240}
DURATION_SEC: dict[Movement, float] = {
    "baseball_pitching": 1.2,
    "running": 0.95,
    "dvj": 1.1,
}


def _downward_link(angle_deg: FloatArray, length_m: float) -> FloatArray:
    angle = np.deg2rad(angle_deg)
    return length_m * np.column_stack(
        (np.sin(angle), -np.cos(angle), np.zeros_like(angle))
    )


def _body(
    movement: Movement, time: FloatArray
) -> tuple[dict[str, FloatArray], FloatArray]:
    phase = time * 2 * np.pi
    if movement == "running":
        knee_flexion = 45 - 28 * np.cos(phase / 0.95) + 8 * np.sin(2 * phase / 0.95)
        thigh_angle = 26 * np.sin(phase / 0.95)
        elbow_flexion = 88 + 12 * np.sin(phase / 0.95)
        travel = 0.5 * time
        height = 0.07 * np.sin(2 * phase / 0.95)
    elif movement == "dvj":
        compression = np.exp(-0.5 * ((time - 0.36) / 0.105) ** 2)
        knee_flexion = 13 + 77 * compression
        thigh_angle = 40 * compression
        elbow_flexion = 25 + 15 * np.sin(phase)
        travel = 0.04 * np.sin(phase)
        height = -0.34 * compression + 0.18 * np.exp(-0.5 * ((time - 0.8) / 0.11) ** 2)
    else:
        knee_flexion = 30 + 24 * np.exp(-0.5 * ((time - 0.46) / 0.12) ** 2)
        thigh_angle = 35 * np.exp(-0.5 * ((time - 0.34) / 0.12) ** 2)
        elbow_flexion = 101 + 9 * np.sin(phase) - 75 * ndtr((time - 0.65) / 0.016)
        travel = 0.52 * ndtr((time - 0.51) / 0.15)
        height = 0.06 * np.sin(phase)
    root = np.column_stack((travel - 0.3, height + 0.12, 0.06 * np.sin(phase)))
    hip = root + [0, 0, 0.12]
    knee = hip + _downward_link(thigh_angle, 0.41)
    ankle = knee + _downward_link(thigh_angle - knee_flexion, 0.43)
    shoulder = root + [0.02, 0.48, 0.21]
    upper_arm_angle = (
        67 * np.exp(-0.5 * ((time - 0.65) / 0.18) ** 2)
        if movement == "baseball_pitching"
        else -thigh_angle
    )
    elbow = shoulder + _downward_link(upper_arm_angle, 0.30)
    wrist = elbow + _downward_link(upper_arm_angle + elbow_flexion, 0.26)
    landmarks = {
        "pelvis": root,
        "sternum": root + [0.06, 0.42, 0.0],
        "right_hip": hip,
        "right_knee": knee,
        "right_knee_left_epicondyle": knee + [0, 0, -0.046],
        "right_knee_right_epicondyle": knee + [0, 0, 0.046],
        "right_ankle": ankle,
        "right_ankle_left_malleolus": ankle + [0, 0, -0.036],
        "right_ankle_right_malleolus": ankle + [0, 0, 0.036],
        "right_shoulder": shoulder,
        "right_elbow": elbow,
        "right_elbow_left_epicondyle": elbow + [0, 0, -0.043],
        "right_elbow_right_epicondyle": elbow + [0, 0, 0.043],
        "right_wrist": wrist,
    }
    return landmarks, elbow_flexion if movement == "baseball_pitching" else knee_flexion


def synthetic_motion(
    movement: Movement,
    rig: Rig,
    *,
    frame_count: int | None = None,
    noise_sd_px: float = NOISE_SD_PX,
    seed: int = SEED,
    occlude: bool = True,
) -> MotionCase:
    fps = FPS[movement]
    count = (
        frame_count
        if frame_count is not None
        else round(DURATION_SEC[movement] * fps) + 1
    )
    if count < 16 or noise_sd_px < 0:
        raise ValueError(
            "synthetic motions need at least 16 frames and nonnegative noise"
        )
    time = np.arange(count, dtype=np.float64) / fps
    landmarks, angles = _body(movement, time)
    names = list(landmarks)
    world = np.stack(list(landmarks.values()), axis=1)
    generator = np.random.default_rng(seed)
    views = []
    noisy_pixels = []
    for index, view in enumerate(rig.views):
        clean = rig.project(world, index)
        noisy = clean + generator.normal(0.0, noise_sd_px, clean.shape)
        noisy_pixels.append(clean)
        frames = []
        for frame_index, (timestamp, row) in enumerate(zip(time, noisy, strict=True)):
            samples = []
            for name, (x, y) in zip(names, row, strict=True):
                hidden = (
                    occlude
                    and index == 1
                    and frame_index in OCCLUSION_FRAMES
                    and name
                    == (
                        "right_wrist"
                        if movement == "baseball_pitching"
                        else "right_ankle_right_malleolus"
                    )
                )
                samples.append(
                    Landmark2D(
                        landmark_id=name,
                        x=None if hidden else float(x),
                        y=None if hidden else float(y),
                        confidence=None if hidden else 1.0,
                        source="tracker_raw",
                        missing_reason="occluded" if hidden else None,
                    )
                )
            frames.append(
                Frame[Landmark2D](
                    frame_index=frame_index,
                    timestamp_sec=float(timestamp),
                    landmarks=samples,
                )
            )
        views.append(
            Pose2DSequence(
                contract_version=CONTRACT_VERSION,
                trial_id=f"synthetic-{movement}",
                view_id=view.view_id,
                coordinate_frame="Image2D",
                unit="px",
                fps=fps,
                width_px=IMAGE_SIZE[0],
                height_px=IMAGE_SIZE[1],
                lens_undistorted=False,
                frames=frames,
            )
        )
    edit_index = min(64, count // 3)
    edit_name = "right_wrist" if movement == "baseball_pitching" else "right_hip"
    x, y = noisy_pixels[0][edit_index, names.index(edit_name)]
    edit = CoordinateRevision(
        contract_version=CONTRACT_VERSION,
        revision_id="coordinates-1",
        expected_head="coordinates-raw",
        parent_revision_id="coordinates-raw",
        operation="edit",
        edits=[
            CoordinateEdit(
                view_id=views[0].view_id,
                frame_index=edit_index,
                landmark=Landmark2D(
                    landmark_id=edit_name,
                    x=float(x),
                    y=float(y),
                    confidence=None,
                    source="manual_edit",
                    missing_reason=None,
                ),
            )
        ],
    )
    spec = METRICS[movement]
    end_frame = min(count - 1, round(DURATION_SEC[movement] * fps))
    annotated = [(spec.first, 0), (spec.last, end_frame)]
    if movement == "dvj":
        peak = int(np.argmax(angles[1:end_frame])) + 1
        annotated.insert(1, ("dvj_peak_landing_flexion", peak))
    events = tuple(
        CaptureEvent(
            event_id=event_id,
            frame_index=index,
            timestamp_sec=float(time[index]),
            detection_mode="manual",
            side="right",
        )
        for event_id, index in annotated
    )
    return MotionCase(
        movement, fps, time, angles, landmarks, (views[0], views[1]), events, edit
    )


def raised_cosine_pulse(amplitude: float = 1.0, half_width: int = 18) -> FloatArray:
    phase = np.arange(-half_width, half_width + 1) * np.pi / half_width
    return np.pad(amplitude * (1 + np.cos(phase)) / 2, 256)
