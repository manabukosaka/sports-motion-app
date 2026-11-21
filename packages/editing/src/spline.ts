export function naturalSpline(timesSec: number[], values: number[]) {
  const knots = timesSec.map((timeSec, index) => ({
    timeSec,
    value: values[index] ?? 0,
    curvature: 0,
    upper: 0,
  }));
  for (let i = 1; i < knots.length - 1; i += 1) {
    const left = knots[i - 1];
    const center = knots[i];
    const right = knots[i + 1];
    if (!left || !center || !right) {
      throw new RangeError("Invalid spline knots");
    }
    const beforeSec = center.timeSec - left.timeSec;
    const afterSec = right.timeSec - center.timeSec;
    const slopeChange =
      (right.value - center.value) / afterSec - (center.value - left.value) / beforeSec;
    const diagonal = 2 * (beforeSec + afterSec) - beforeSec * left.upper;
    center.upper = afterSec / diagonal;
    center.curvature = (6 * slopeChange - beforeSec * left.curvature) / diagonal;
  }
  for (let i = knots.length - 2; i > 0; i -= 1) {
    const center = knots[i];
    const right = knots[i + 1];
    if (center && right) {
      center.curvature -= center.upper * right.curvature;
    }
  }
  return (timeSec: number) => {
    const rightIndex = knots.findIndex((knot) => knot.timeSec >= timeSec);
    const left = knots[rightIndex - 1];
    const right = knots[rightIndex];
    if (!left || !right) {
      throw new RangeError("Spline evaluation must be bracketed by anchors");
    }
    const widthSec = right.timeSec - left.timeSec;
    const a = (right.timeSec - timeSec) / widthSec;
    const b = 1 - a;
    return (
      a * left.value +
      b * right.value +
      (((a ** 3 - a) * left.curvature + (b ** 3 - b) * right.curvature) * widthSec ** 2) / 6
    );
  };
}
