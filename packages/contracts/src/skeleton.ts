import type { Pose3DSequence } from "./types.js";
import { asMeters, type Meters } from "./units.js";

export type SkeletonPoint = [x: Meters, y: Meters, z: Meters];

const sides = ["left", "right"] as const;
const bones: [string, string][] = [
  ["left_shoulder", "right_shoulder"],
  ["left_hip", "right_hip"],
  ...sides.flatMap<[string, string]>((side) => [
    [`${side}_shoulder`, `${side}_hip`],
    [`${side}_shoulder`, `${side}_elbow`],
    [`${side}_elbow`, `${side}_wrist`],
    [`${side}_hip`, `${side}_knee`],
    [`${side}_knee`, `${side}_ankle`],
  ]),
];
const centers = [
  ["elbow", "epicondyle"],
  ["knee", "epicondyle"],
  ["ankle", "malleolus"],
] as const;

export function skeletonGeometry(frame: Pose3DSequence["frames"][number]) {
  const joints = new Map<string, SkeletonPoint>();
  for (const point of frame.landmarks) {
    if (point.missing_reason === null) {
      joints.set(point.landmark_id, [point.x, point.y, point.z]);
    }
  }
  for (const side of sides) {
    for (const [joint, marker] of centers) {
      const name = `${side}_${joint}`;
      const left = joints.get(`${name}_left_${marker}`);
      const right = joints.get(`${name}_right_${marker}`);
      if (!joints.has(name) && left && right) {
        joints.set(name, [
          asMeters(left[0] / 2 + right[0] / 2),
          asMeters(left[1] / 2 + right[1] / 2),
          asMeters(left[2] / 2 + right[2] / 2),
        ]);
      }
    }
  }
  const indices = new Map(Array.from(joints.keys(), (name, index) => [name, index]));
  const segments: [number, number][] = [];
  for (const [first, second] of bones) {
    const start = indices.get(first);
    const end = indices.get(second);
    if (start !== undefined && end !== undefined) {
      segments.push([start, end]);
    }
  }
  return { joints: Array.from(joints), segments };
}
