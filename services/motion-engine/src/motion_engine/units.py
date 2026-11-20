from __future__ import annotations

from math import degrees, dist, radians
from typing import Literal, Self

from .contracts import (
    Contract,
    Fraction,
    NonBlank,
    NonNegative,
    StrictFalse,
    StrictTrue,
)


class _Point(Contract):
    x: float
    y: float

    def axes(self) -> tuple[float, ...]:
        return self.x, self.y

    def distance_to(self, other: Self) -> float:
        if type(self) is not type(other):
            raise TypeError("distance requires matching coordinate frames and units")
        return dist(self.axes(), other.axes())


class Image2D(_Point):
    coordinate_frame: Literal["Image2D"] = "Image2D"
    unit: Literal["px"] = "px"
    view_id: NonBlank
    lens_undistorted: bool

    def distance_to(self, other: Self) -> float:
        if not isinstance(other, Image2D) or (self.view_id, self.lens_undistorted) != (
            other.view_id,
            other.lens_undistorted,
        ):
            raise TypeError(
                "image distance requires matching view and distortion space"
            )
        return super().distance_to(other)


class _Point3D(_Point):
    z: float
    unit: Literal["m"] = "m"

    def axes(self) -> tuple[float, ...]:
        return self.x, self.y, self.z


class Camera3D(_Point3D):
    coordinate_frame: Literal["Camera3D"] = "Camera3D"
    view_id: NonBlank

    def distance_to(self, other: Self) -> float:
        if not isinstance(other, Camera3D) or self.view_id != other.view_id:
            raise TypeError("camera distance requires matching views")
        return super().distance_to(other)


class CalibratedWorld3D(_Point3D):
    coordinate_frame: Literal["CalibratedWorld3D"] = "CalibratedWorld3D"
    is_metric_calibrated: StrictTrue = True


class HipRelative3D(_Point3D):
    coordinate_frame: Literal["HipRelative3D"] = "HipRelative3D"
    is_metric_calibrated: StrictFalse = False


class _AngularValue(Contract):
    value: float

    def __add__(self, other: Self) -> Self:
        if type(self) is not type(other):
            raise TypeError("angle addition requires matching units")
        return type(self)(value=self.value + other.value)

    def __sub__(self, other: Self) -> Self:
        if type(self) is not type(other):
            raise TypeError("angle subtraction requires matching units")
        return type(self)(value=self.value - other.value)


class Degrees(_AngularValue):
    unit: Literal["deg"] = "deg"

    def to_radians(self) -> Radians:
        return Radians(value=radians(self.value))


class Radians(_AngularValue):
    unit: Literal["rad"] = "rad"

    def to_degrees(self) -> Degrees:
        return Degrees(value=degrees(self.value))


class DegreesPerSecond(_AngularValue):
    unit: Literal["deg_per_s"] = "deg_per_s"

    def to_radians_per_second(self) -> RadiansPerSecond:
        return RadiansPerSecond(value=radians(self.value))


class RadiansPerSecond(_AngularValue):
    unit: Literal["rad_per_s"] = "rad_per_s"

    def to_degrees_per_second(self) -> DegreesPerSecond:
        return DegreesPerSecond(value=degrees(self.value))


class TimestampSeconds(Contract):
    timestamp_sec: NonNegative


class NormalizedTime(Contract):
    normalized_time_fraction: Fraction
