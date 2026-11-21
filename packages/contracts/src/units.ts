declare const brand: unique symbol;
type Branded<Value, Unit extends string> = Value & { readonly [brand]: Unit };

export type Degrees = Branded<number, "deg">;
export type Radians = Branded<number, "rad">;
export type Meters = Branded<number, "m">;
export type Pixels = Branded<number, "px">;
export type Seconds = Branded<number, "s">;
export type FrameIndex = Branded<number, "frame_index">;
export type Millimeters = Branded<number, "mm">;
export type MetersPerSecond = Branded<number, "m_per_s">;
export type RadiansPerSecond = Branded<number, "rad_per_s">;
export type DegreesPerSecond = Branded<number, "deg_per_s">;
export type NormalizedPercent = Branded<number, "percent">;
export type ViewId = Branded<string, "view_id">;

function finite<Unit extends string>(value: number, unit: Unit): Branded<number, Unit> {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Expected a finite value in ${unit}`);
  }
  return value as Branded<number, Unit>;
}

export const asDegrees = (value: number): Degrees => finite(value, "deg");
export const asRadians = (value: number): Radians => finite(value, "rad");
export const asMeters = (value: number): Meters => finite(value, "m");
export const asPixels = (value: number): Pixels => finite(value, "px");
export const asSeconds = (value: number): Seconds => finite(value, "s");
export const asMillimeters = (value: number): Millimeters => finite(value, "mm");
export const asMetersPerSecond = (value: number): MetersPerSecond => finite(value, "m_per_s");
export const asRadiansPerSecond = (value: number): RadiansPerSecond => finite(value, "rad_per_s");
export const asDegreesPerSecond = (value: number): DegreesPerSecond => finite(value, "deg_per_s");

export function asFrameIndex(value: number): FrameIndex {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Expected a non-negative integer frame index");
  }
  return value as FrameIndex;
}

export function asNormalizedPercent(value: number): NormalizedPercent {
  const percent = finite(value, "percent");
  if (percent < 0 || percent > 100) {
    throw new RangeError("Expected a percentage between 0 and 100");
  }
  return percent;
}

export function asViewId(value: string): ViewId {
  if (typeof value !== "string" || !/\S/u.test(value)) {
    throw new TypeError("Expected a non-blank view ID");
  }
  return value as ViewId;
}

const radiansPerDegree = Math.PI / 180;

export const degToRad = (angle: Degrees): Radians => asRadians(angle * radiansPerDegree);
export const radToDeg = (angle: Radians): Degrees => asDegrees(angle / radiansPerDegree);
export const metersToMillimeters = (length: Meters): Millimeters => asMillimeters(length * 1000);
export const radPerSecToDegPerSec = (speed: RadiansPerSecond): DegreesPerSecond =>
  asDegreesPerSecond(speed / radiansPerDegree);
export const degPerSecToRadPerSec = (speed: DegreesPerSecond): RadiansPerSecond =>
  asRadiansPerSecond(speed * radiansPerDegree);

export const addDegrees = (first: Degrees, second: Degrees): Degrees => asDegrees(first + second);
export const addMeters = (first: Meters, second: Meters): Meters => asMeters(first + second);
export const addPixels = (first: Pixels, second: Pixels): Pixels => asPixels(first + second);

export interface Image2DPoint {
  readonly frame: "Image2D";
  readonly viewId: ViewId;
  readonly x: Pixels;
  readonly y: Pixels;
}

export interface CalibratedWorld3DPoint {
  readonly frame: "CalibratedWorld3D";
  readonly x: Meters;
  readonly y: Meters;
  readonly z: Meters;
  readonly isMetric: true;
}

export interface HipRelative3DPoint {
  readonly frame: "HipRelative3D";
  readonly x: Meters;
  readonly y: Meters;
  readonly z: Meters;
  readonly isMetric: false;
}

export function distanceWorld3D(
  first: CalibratedWorld3DPoint,
  second: CalibratedWorld3DPoint,
): Meters {
  return asMeters(Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z));
}
