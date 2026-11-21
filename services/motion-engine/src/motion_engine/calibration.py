from dataclasses import dataclass
from typing import Literal, Sequence

import cv2
import numpy as np
from numpy.typing import NDArray

from .contracts import (
    DLTCalibration,
    DLTCheck,
    DLTView,
    Intrinsics,
    StereoCalibration,
    StereoCheck,
    StereoView,
)
from .units import CalibratedWorld3D, Camera3D, Image2D

FloatArray = NDArray[np.float64]
StereoPair = tuple[StereoView, StereoView]


def points_array(values: FloatArray, dimensions: int) -> FloatArray:
    data = np.asarray(values, dtype=np.float64)
    if data.ndim != 2 or data.shape[1] != dimensions or not np.isfinite(data).all():
        raise ValueError(f"expected finite points of shape (n, {dimensions})")
    return data


def camera_matrix(view: StereoView) -> FloatArray:
    k = view.intrinsics
    return np.array(
        [[k.fx_px, 0, k.cx_px], [0, k.fy_px, k.cy_px], [0, 0, 1]], dtype=np.float64
    )


def undistort_pixels(pixels: FloatArray, view: StereoView) -> FloatArray:
    pixels = points_array(pixels, 2)
    if len(pixels) == 0 or not any(view.distortion_coefficients):
        return pixels.copy()
    intrinsic = camera_matrix(view)
    distortion = np.asarray(view.distortion_coefficients)
    return np.asarray(
        cv2.undistortPoints(pixels, intrinsic, distortion, P=intrinsic),
        dtype=np.float64,
    ).reshape(-1, 2)


def undistort_point(point: Image2D, view: StereoView) -> Image2D:
    if not isinstance(point, Image2D) or point.view_id != view.view_id:
        raise TypeError("lens correction requires Image2D from the calibrated view")
    if point.lens_undistorted:
        return point
    x, y = undistort_pixels(np.array([point.axes()]), view)[0]
    return Image2D(x=float(x), y=float(y), view_id=point.view_id, lens_undistorted=True)


def project_world_pixels(projection: FloatArray, world_m: FloatArray) -> FloatArray:
    camera = points_array(world_m, 3) @ projection[:, :3].T + projection[:, 3]
    if np.any(camera[:, 2] <= 0):
        raise ValueError("projection contains points behind the camera")
    return camera[:, :2] / camera[:, 2, None]


@dataclass(frozen=True)
class ProjectionCamera:
    view: StereoView
    projection: FloatArray
    rotation: FloatArray
    center_m: FloatArray

    def to_camera(self, point: CalibratedWorld3D) -> Camera3D:
        if not isinstance(point, CalibratedWorld3D):
            raise TypeError("camera transform requires calibrated world coordinates")
        x, y, z = self.rotation @ (np.asarray(point.axes()) - self.center_m)
        return Camera3D(x=float(x), y=float(y), z=float(z), view_id=self.view.view_id)

    def project(self, point: Camera3D) -> Image2D:
        if not isinstance(point, Camera3D) or point.view_id != self.view.view_id:
            raise TypeError("projection requires Camera3D from this view")
        world_m = self.center_m + self.rotation.T @ np.asarray(point.axes())
        x, y = project_world_pixels(self.projection, world_m[None, :])[0]
        return Image2D(
            x=float(x), y=float(y), view_id=self.view.view_id, lens_undistorted=True
        )


def dlt_camera(view: DLTView) -> ProjectionCamera:
    projection = np.array([*view.dlt_params, 1.0]).reshape(3, 4)
    determinant = np.linalg.det(projection[:, :3])
    if np.linalg.matrix_rank(projection[:, :3]) != 3:
        raise ValueError("degenerate DLT projection")
    if determinant < 0:
        projection = -projection
    _, rotation, center, *_ = cv2.decomposeProjectionMatrix(projection)
    return ProjectionCamera(
        view,
        projection,
        np.asarray(rotation, dtype=np.float64),
        np.asarray(center[:3] / center[3], dtype=np.float64).ravel(),
    )


def _normalize_points(points: FloatArray) -> tuple[FloatArray, FloatArray]:
    centered = points - points.mean(axis=0)
    spread = np.sqrt(np.mean(np.sum(centered**2, axis=1)))
    if spread == 0:
        raise ValueError("coincident calibration points")
    dimensions = points.shape[1]
    scale = np.sqrt(dimensions) / spread
    transform = np.eye(dimensions + 1)
    transform[:dimensions, :dimensions] *= scale
    transform[:dimensions, -1] = -points.mean(axis=0) * scale
    return np.column_stack((centered * scale, np.ones(len(points)))), transform


def fit_dlt_view(
    view: StereoView, world_m: FloatArray, distorted_px: FloatArray
) -> DLTView:
    world_m = points_array(world_m, 3)
    pixels = undistort_pixels(distorted_px, view)
    if len(world_m) < 6 or len(world_m) != len(pixels):
        raise ValueError("DLT needs at least six matched control points")
    if np.linalg.matrix_rank(world_m - world_m.mean(axis=0)) != 3:
        raise ValueError("DLT needs non-coplanar control points")
    world, world_transform = _normalize_points(world_m)
    image, image_transform = _normalize_points(pixels)
    zeros = np.zeros_like(world)
    equations = np.vstack(
        (
            np.column_stack((world, zeros, -image[:, 0, None] * world)),
            np.column_stack((zeros, world, -image[:, 1, None] * world)),
        )
    )
    _, singular_values, vh = np.linalg.svd(equations, full_matrices=False)
    if singular_values[-2] <= singular_values[0] * 1e-12:
        raise ValueError("degenerate DLT control correspondences")
    projection = np.linalg.solve(
        image_transform, vh[-1].reshape(3, 4) @ world_transform
    )
    if abs(projection[2, 3]) <= 1e-12 * np.linalg.norm(projection[2]):
        raise ValueError("DLT world origin lies on the camera plane")
    result = DLTView(
        view_id=view.view_id,
        intrinsics=view.intrinsics,
        distortion_coefficients=view.distortion_coefficients,
        dlt_params=(projection / projection[2, 3]).ravel()[:11].tolist(),
    )
    project_world_pixels(dlt_camera(result).projection, world_m)
    return result


def fit_dlt_calibration(
    calibration_id: str,
    contract_version: str,
    views: StereoPair,
    control_world_m: FloatArray,
    control_pixels: tuple[FloatArray, FloatArray],
    check_world_m: FloatArray,
    check_pixels: tuple[FloatArray, FloatArray],
) -> DLTCalibration:
    from .reconstruction import triangulate_pixels

    check_world_m = points_array(check_world_m, 3)
    if len(check_world_m) < 2 or any(
        len(pixels) != len(check_world_m) for pixels in check_pixels
    ):
        raise ValueError("DLT needs matched held-out points for a known distance check")
    fitted = [
        fit_dlt_view(view, control_world_m, pixels)
        for view, pixels in zip(views, control_pixels, strict=True)
    ]
    cameras = [dlt_camera(view) for view in fitted]
    corrected = [
        undistort_pixels(pixels, view)
        for view, pixels in zip(views, check_pixels, strict=True)
    ]
    errors = np.concatenate(
        [
            project_world_pixels(cam.projection, check_world_m) - pixels
            for cam, pixels in zip(cameras, corrected, strict=True)
        ]
    )
    reconstructed, valid = triangulate_pixels(cameras, corrected)
    if not valid.all():
        raise ValueError("held-out points cannot be triangulated")
    first, second = np.triu_indices(len(check_world_m), k=1)
    actual = np.linalg.norm(reconstructed[first] - reconstructed[second], axis=1)
    expected = np.linalg.norm(check_world_m[first] - check_world_m[second], axis=1)
    return DLTCalibration(
        contract_version=contract_version,
        calibration_id=calibration_id,
        mode="dlt_control_poles",
        views=fitted,
        held_out_check=DLTCheck(
            reprojection_error_px=float(np.sqrt(np.mean(np.sum(errors**2, axis=1)))),
            known_distance_rmse_m=float(np.sqrt(np.mean((actual - expected) ** 2))),
        ),
    )


@dataclass(frozen=True)
class BoardObservation:
    """Matched board corners in meters and distorted pixels in both views.

    For ChArUco, provide the intersection of detected corner IDs in matching order.
    """

    board_m: FloatArray
    first_px: FloatArray
    second_px: FloatArray

    def matched(self) -> tuple[FloatArray, FloatArray, FloatArray]:
        board = points_array(self.board_m, 3)
        left = points_array(self.first_px, 2)
        right = points_array(self.second_px, 2)
        if len(board) < 6 or len(board) != len(left) or len(board) != len(right):
            raise ValueError(
                "stereo calibration requires six or more matched board corners"
            )
        if np.linalg.matrix_rank(board - board.mean(axis=0), tol=1e-10) != 2:
            raise ValueError("board points must span a plane")
        if any(
            np.linalg.matrix_rank(pixels - pixels.mean(axis=0)) != 2
            for pixels in (left, right)
        ):
            raise ValueError("board corners must span both image axes")
        return board, left, right

    def corrected(self, views: StereoPair) -> tuple[FloatArray, FloatArray, FloatArray]:
        board, left, right = self.matched()
        return (
            board,
            undistort_pixels(left, views[0]),
            undistort_pixels(right, views[1]),
        )


def fit_stereo_calibration(
    calibration_id: str,
    contract_version: str,
    views: StereoPair,
    image_size_px: tuple[int, int],
    observations: Sequence[BoardObservation],
    held_out: Sequence[BoardObservation],
) -> StereoCalibration:
    if len(observations) < 3 or not held_out or min(image_size_px) <= 0:
        raise ValueError(
            "stereo calibration needs three fit boards, held-out boards and image dimensions"
        )
    fit = [observation.corrected(views) for observation in observations]
    board, left, right = (
        [sample[column].astype(np.float32) for sample in fit] for column in range(3)
    )
    k0, k1 = (camera_matrix(view) for view in views)
    zeros = np.zeros(5)
    rms, _, _, _, _, rotation, translation, _, _ = cv2.stereoCalibrate(
        board,
        left,
        right,
        k0,
        zeros.copy(),
        k1,
        zeros.copy(),
        image_size_px,
        flags=cv2.CALIB_FIX_INTRINSIC,
    )
    return _checked_stereo(
        calibration_id,
        contract_version,
        views,
        rms,
        np.asarray(rotation, dtype=np.float64),
        np.asarray(translation, dtype=np.float64),
        held_out,
    )


def calibrate_checkerboard_stereo(
    calibration_id: str,
    contract_version: str,
    view_ids: tuple[str, str],
    image_size_px: tuple[int, int],
    observations: Sequence[BoardObservation],
    held_out: Sequence[BoardObservation],
) -> StereoCalibration:
    """Fit both cameras from matched planar board coordinates in meters.

    Supply diverse board poses with local Z=0 and separate held-out captures.
    Checkerboard or ChArUco corners must use the same correspondence order.
    """
    if len(observations) < 3 or not held_out or min(image_size_px) <= 0:
        raise ValueError(
            "stereo calibration needs three fit boards, held-out boards and image dimensions"
        )
    if view_ids[0] == view_ids[1]:
        raise ValueError("calibration views must be distinct")
    fit = [observation.matched() for observation in observations]
    if any(np.any(np.abs(obj[:, 2]) > 1e-10) for obj, _, _ in fit):
        raise ValueError("intrinsic calibration requires board-local corners with Z=0")
    board, left, right = (
        [sample[column].astype(np.float32) for sample in fit] for column in range(3)
    )
    criteria = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 100, 1e-10)
    try:
        _, k0, d0, rotations, _, *_ = cv2.calibrateCamera(
            board, left, image_size_px, None, None, criteria=criteria
        )
        _, k1, d1, *_ = cv2.calibrateCamera(
            board, right, image_size_px, None, None, criteria=criteria
        )
        normals = np.stack([cv2.Rodrigues(r)[0][:, 2] for r in rotations])
        if np.linalg.matrix_rank(normals, tol=1e-3) < 3:
            raise ValueError(
                "intrinsic calibration requires board tilt about both axes"
            )
        rms, k0, d0, k1, d1, rotation, translation, _, _ = cv2.stereoCalibrate(
            board,
            left,
            right,
            k0,
            d0,
            k1,
            d1,
            image_size_px,
            criteria=criteria,
            flags=cv2.CALIB_USE_INTRINSIC_GUESS,
        )
    except cv2.error as error:
        raise ValueError("checkerboard camera calibration failed") from error

    views = tuple(
        StereoView(
            view_id=view_id,
            intrinsics=Intrinsics(
                fx_px=float(matrix[0, 0]),
                fy_px=float(matrix[1, 1]),
                cx_px=float(matrix[0, 2]),
                cy_px=float(matrix[1, 2]),
            ),
            distortion_coefficients=distortion.ravel().tolist(),
        )
        for view_id, matrix, distortion in zip(
            view_ids, (k0, k1), (d0, d1), strict=True
        )
    )
    try:
        result = _checked_stereo(
            calibration_id,
            contract_version,
            (views[0], views[1]),
            rms,
            np.asarray(rotation, dtype=np.float64),
            np.asarray(translation, dtype=np.float64),
            held_out,
        )
    except cv2.error as error:
        raise ValueError("held-out checkerboard verification failed") from error
    if max(result.fit_rms_px, result.held_out_check.reprojection_error_px) >= 0.5:
        raise ValueError("stereo calibration reprojection RMSE must be below 0.5 px")
    return result


def _checked_stereo(
    calibration_id: str,
    contract_version: str,
    views: StereoPair,
    rms: float,
    rotation: FloatArray,
    translation: FloatArray,
    held_out: Sequence[BoardObservation],
) -> StereoCalibration:
    from .kinematics import verify_rotation

    verify_rotation(rotation)
    translation = translation.ravel()
    if not np.isfinite(translation).all() or np.linalg.norm(translation) < 1e-9:
        raise ValueError("stereo calibration needs a nonzero camera baseline")
    k0, k1 = (camera_matrix(view) for view in views)
    projection = k1 @ np.column_stack((rotation, translation))
    errors = []
    for observation in held_out:
        obj, left_px, right_px = observation.corrected(views)
        solved, board_rotation, board_translation = cv2.solvePnP(obj, left_px, k0, None)
        if not solved:
            raise ValueError("held-out board pose could not be determined")
        board_matrix, _ = cv2.Rodrigues(board_rotation)
        first_camera_m = obj @ board_matrix.T + board_translation.ravel()
        if np.any(first_camera_m[:, 2] <= 0):
            raise ValueError("held-out board must be in front of both cameras")
        errors.append(project_world_pixels(projection, first_camera_m) - right_px)
    return StereoCalibration(
        contract_version=contract_version,
        calibration_id=calibration_id,
        mode="stereo_checkerboard_charuco",
        views=list(views),
        rotation_matrix=rotation.tolist(),
        translation_m=translation.tolist(),
        fit_rms_px=float(rms),
        held_out_check=StereoCheck(
            reprojection_error_px=float(
                np.sqrt(np.mean(np.sum(np.concatenate(errors) ** 2, axis=1)))
            ),
        ),
    )


def projection_cameras(
    calibration: DLTCalibration | StereoCalibration,
) -> tuple[list[ProjectionCamera], Literal["dlt", "stereo"]]:
    """Use the control-pole frame for DLT and the first camera's metric frame for stereo."""
    if isinstance(calibration, DLTCalibration):
        return [dlt_camera(view) for view in calibration.views], "dlt"
    if not isinstance(calibration, StereoCalibration):
        raise TypeError("metric projection requires a two-view calibration")

    from .kinematics import verify_rotation

    rotation = verify_rotation(np.asarray(calibration.rotation_matrix))
    translation = np.asarray(calibration.translation_m)
    if np.linalg.norm(translation) < 1e-9:
        raise ValueError("stereo calibration needs a nonzero camera baseline")
    first, second = calibration.views
    return [
        ProjectionCamera(
            first, camera_matrix(first) @ np.eye(3, 4), np.eye(3), np.zeros(3)
        ),
        ProjectionCamera(
            second,
            camera_matrix(second) @ np.column_stack((rotation, translation)),
            rotation,
            -rotation.T @ translation,
        ),
    ], "stereo"
