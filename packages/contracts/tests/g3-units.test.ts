import fc from "fast-check";
import { expect, test } from "vitest";
import calibration from "../fixtures/valid/calibration.dlt.json" with { type: "json" };
import pose2d from "../fixtures/valid/pose2d.json" with { type: "json" };
import hipPose from "../fixtures/valid/pose3d.hip.json" with { type: "json" };
import worldPose from "../fixtures/valid/pose3d.world.json" with { type: "json" };
import share from "../fixtures/valid/share_report.json" with { type: "json" };
import {
  addDegrees,
  addMeters,
  addPixels,
  asDegrees,
  asDegreesPerSecond,
  asFrameIndex,
  asMeters,
  asMetersPerSecond,
  asMillimeters,
  asNormalizedPercent,
  asPixels,
  asRadians,
  asRadiansPerSecond,
  asSeconds,
  asViewId,
  type CalibratedWorld3DPoint,
  degPerSecToRadPerSec,
  degToRad,
  distanceWorld3D,
  type HipRelative3DPoint,
  type Image2DPoint,
  metersToMillimeters,
  radPerSecToDegPerSec,
  radToDeg,
  validateContract,
} from "../src/index.js";

export function checkG3Types(hip: HipRelative3DPoint, world: CalibratedWorld3DPoint) {
  const degrees = asDegrees(90);
  const radians = asRadians(Math.PI / 2);
  const meters = asMeters(1);
  const pixels = asPixels(1);
  const viewId = asViewId("side");

  // @ts-expect-error G3 prohibits passing degrees as radians.
  radToDeg(degrees);
  // @ts-expect-error G3 prohibits passing radians as degrees.
  degToRad(radians);
  // @ts-expect-error G3 prohibits passing meters as pixels.
  addPixels(pixels, meters);
  // @ts-expect-error G3 prohibits passing pixels as meters.
  addMeters(meters, pixels);
  // @ts-expect-error G3 prohibits assigning hip-relative coordinates to a calibrated frame.
  const mislabeled: CalibratedWorld3DPoint = hip;
  // @ts-expect-error G3 prohibits world distance on hip-relative coordinates.
  distanceWorld3D(world, hip);
  // @ts-expect-error G3 requires a view identifier in Image2D.
  const noView: Image2DPoint = { frame: "Image2D", x: pixels, y: pixels };
  // @ts-expect-error G3 requires pixels in Image2D.
  const wrongUnit: Image2DPoint = { frame: "Image2D", viewId, x: meters, y: pixels };
  return { mislabeled, noView, wrongUnit };
}

const runs = { seed: 27, numRuns: 100 };
const viewIds = fc.string({ minLength: 1 }).filter((value) => /\S/u.test(value));

test("G3 angle conversions round-trip within 1e-12", () => {
  const degrees = fc.double({ min: -360, max: 360, noNaN: true });
  const radians = fc.double({ min: -2 * Math.PI, max: 2 * Math.PI, noNaN: true });
  fc.assert(
    fc.property(degrees, radians, (deg, rad) => {
      expect(Math.abs(radToDeg(degToRad(asDegrees(deg))) - deg)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(degToRad(radToDeg(asRadians(rad))) - rad)).toBeLessThanOrEqual(1e-12);
    }),
    runs,
  );
});

test("G3 constructors reject all non-finite numeric values", () => {
  const constructors = [
    asDegrees,
    asRadians,
    asMeters,
    asPixels,
    asSeconds,
    asFrameIndex,
    asMillimeters,
    asMetersPerSecond,
    asRadiansPerSecond,
    asDegreesPerSecond,
    asNormalizedPercent,
  ];
  for (const construct of constructors) {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => construct(value)).toThrow(RangeError);
    }
  }
});

test("G3 helpers convert and operate on compatible quantities", () => {
  expect(addDegrees(asDegrees(1), asDegrees(2))).toBe(3);
  expect(addMeters(asMeters(1), asMeters(2))).toBe(3);
  expect(addPixels(asPixels(1), asPixels(2))).toBe(3);
  expect(metersToMillimeters(asMeters(1.5))).toBe(1500);
  expect(degPerSecToRadPerSec(asDegreesPerSecond(180))).toBe(Math.PI);
  expect(radPerSecToDegPerSec(asRadiansPerSecond(Math.PI))).toBe(180);
  expect(asNormalizedPercent(100)).toBe(100);
  expect(() => asNormalizedPercent(101)).toThrow(RangeError);
  expect(() => asFrameIndex(0.5)).toThrow(RangeError);
  expect(() => asViewId(" ")).toThrow(TypeError);
  const origin: CalibratedWorld3DPoint = {
    frame: "CalibratedWorld3D",
    isMetric: true,
    x: asMeters(0),
    y: asMeters(0),
    z: asMeters(0),
  };
  expect(distanceWorld3D(origin, { ...origin, x: asMeters(3), z: asMeters(4) })).toBe(5);
});

test("G3 rejects arbitrary wrong pose units while accepting the correct units", () => {
  fc.assert(
    fc.property(
      fc.string().filter((unit) => unit !== "px" && unit !== "m"),
      (unit) => {
        expect(validateContract("pose2d", { ...pose2d, unit })).toBe(false);
        expect(validateContract("pose3d", { ...hipPose, unit })).toBe(false);
      },
    ),
    runs,
  );
  expect(validateContract("pose2d", pose2d)).toBe(true);
  expect(validateContract("pose3d", hipPose)).toBe(true);
});

test("G3 rejects swapped metric claims on both 3D frames", () => {
  fc.assert(
    fc.property(fc.nat(100), (stability) => {
      const hip = { ...hipPose, bone_length_stability_mm: stability };
      const world = { ...worldPose, bone_length_stability_mm: stability };
      expect(validateContract("pose3d", hip)).toBe(true);
      expect(validateContract("pose3d", world)).toBe(true);
      expect(validateContract("pose3d", { ...hip, is_metric_calibrated: true })).toBe(false);
      expect(validateContract("pose3d", { ...world, is_metric_calibrated: false })).toBe(false);
    }),
    runs,
  );
});

test("G3 requires a non-blank view identifier on a 2D sequence", () => {
  const { view_id, ...withoutViewId } = pose2d;
  expect(validateContract("pose2d", withoutViewId)).toBe(false);
  expect(validateContract("pose2d", { ...withoutViewId, view_id: " " })).toBe(false);
  expect(validateContract("pose2d", { ...withoutViewId, view_id })).toBe(true);
});

test.each([
  { kind: "pose2d", pose: pose2d },
  { kind: "pose3d", pose: worldPose },
] as const)("G3 rejects duplicate and out-of-order indices and timestamps in $kind", ({
  kind,
  pose,
}) => {
  fc.assert(
    fc.property(fc.nat(1000), fc.nat(1000), (index, elapsed) => {
      const start = { frame_index: index + 1, timestamp_sec: elapsed + 1, landmarks: [] };
      const end = { frame_index: index + 2, timestamp_sec: elapsed + 2, landmarks: [] };
      expect(validateContract(kind, { ...pose, frames: [start, end] })).toBe(true);
      for (const invalid of [
        { ...end, frame_index: index },
        { ...end, frame_index: index + 1 },
        { ...end, timestamp_sec: elapsed },
        { ...end, timestamp_sec: elapsed + 1 },
      ]) {
        expect(validateContract(kind, { ...pose, frames: [start, invalid] })).toBe(false);
      }
    }),
    runs,
  );
});

test("G3 rejects duplicate calibration views and accepts distinct views", () => {
  fc.assert(
    fc.property(viewIds, (viewId) => {
      const views = calibration.views.map((view) => ({ ...view, view_id: viewId }));
      expect(validateContract("calibration", { ...calibration, views })).toBe(false);
      const distinct = views.map((view, index) => ({
        ...view,
        view_id: `${view.view_id}/${index}`,
      }));
      expect(validateContract("calibration", { ...calibration, views: distinct })).toBe(true);
    }),
    runs,
  );
});

test("G3 requires a non-diagnostic flag on share reports", () => {
  fc.assert(
    fc.property(viewIds, (id) => {
      const report = { ...share, share_link_id: id };
      expect(validateContract("share_report", report)).toBe(true);
      expect(validateContract("share_report", { ...report, non_diagnostic_flag: false })).toBe(
        false,
      );
    }),
    runs,
  );
});

test("G3 rejects non-finite wire coordinates and timestamps", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(
      validateContract("pose2d", {
        ...pose2d,
        frames: pose2d.frames.map((frame) => ({ ...frame, timestamp_sec: value })),
      }),
    ).toBe(false);
    expect(
      validateContract("pose3d", {
        ...worldPose,
        frames: worldPose.frames.map((frame) => ({
          ...frame,
          landmarks: frame.landmarks.map((point) => ({ ...point, x: value })),
        })),
      }),
    ).toBe(false);
  }
});
