import { asFrameIndex, type FrameIndex } from "@sports-motion/contracts";

export type DrawingAnnotationKind = "line" | "angle" | "circle" | "label";
export type CoachingCommentAuthorRole = "Coach" | "OrgAdmin" | "Athlete";

export interface NormalizedImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface DrawingAnnotation {
  readonly id: string;
  readonly kind: DrawingAnnotationKind;
  readonly startFrame: FrameIndex;
  readonly endFrame: FrameIndex;
  readonly points: readonly NormalizedImagePoint[];
  readonly colorHex: string;
  readonly label?: string;
  readonly radius?: number;
}

export type CoachingComment =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly frameIndex: FrameIndex;
      readonly authorRole: CoachingCommentAuthorRole;
      readonly createdAt: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly kind: "voice_note";
      readonly frameIndex: FrameIndex;
      readonly authorRole: CoachingCommentAuthorRole;
      readonly createdAt: string;
      readonly audioDurationSec: number;
      readonly text?: string;
    };

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
const ALLOWED_DRAWING_KINDS = new Set<DrawingAnnotationKind>(["line", "angle", "circle", "label"]);
const ALLOWED_AUTHOR_ROLES = new Set<CoachingCommentAuthorRole>(["Coach", "OrgAdmin", "Athlete"]);
const MINIMUM_POINTS_BY_KIND: Record<DrawingAnnotationKind, number> = {
  line: 2,
  angle: 3,
  circle: 1,
  label: 1,
};

function requireNonBlankString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !/\S/u.test(value)) {
    throw new TypeError(`${fieldName} must be a non-blank string`);
  }
  return value;
}

function validateNormalizedPoint(point: NormalizedImagePoint, index: number): NormalizedImagePoint {
  if (
    point === null ||
    typeof point !== "object" ||
    typeof point.x !== "number" ||
    typeof point.y !== "number" ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new RangeError(`Annotation point ${index} must have finite coordinates`);
  }
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new RangeError(`Annotation point ${index} coordinates must be within [0, 1]`);
  }
  return Object.freeze({ x: point.x, y: point.y });
}

export function validateDrawingAnnotation(annotation: DrawingAnnotation): DrawingAnnotation {
  if (annotation === null || typeof annotation !== "object") {
    throw new TypeError("Drawing annotation must be an object");
  }
  const id = requireNonBlankString(annotation.id, "annotation.id");
  if (!ALLOWED_DRAWING_KINDS.has(annotation.kind)) {
    throw new TypeError(`Unsupported drawing annotation kind: ${String(annotation.kind)}`);
  }
  const startFrame = asFrameIndex(annotation.startFrame);
  const endFrame = asFrameIndex(annotation.endFrame);
  if (endFrame < startFrame) {
    throw new RangeError("Annotation endFrame must be >= startFrame");
  }
  if (!Array.isArray(annotation.points)) {
    throw new TypeError("Annotation points must be an array");
  }
  const minimumPoints = MINIMUM_POINTS_BY_KIND[annotation.kind];
  if (annotation.points.length < minimumPoints) {
    throw new RangeError(
      `Annotation kind "${annotation.kind}" requires at least ${minimumPoints} point(s)`,
    );
  }
  const points = Object.freeze(
    annotation.points.map((point, index) => validateNormalizedPoint(point, index)),
  );
  if (typeof annotation.colorHex !== "string" || !HEX_COLOR_PATTERN.test(annotation.colorHex)) {
    throw new RangeError("Annotation colorHex must match /^#[0-9a-fA-F]{6}$/");
  }
  if (annotation.kind === "label") {
    requireNonBlankString(annotation.label, "annotation.label");
  } else if (annotation.label !== undefined && typeof annotation.label !== "string") {
    throw new TypeError("Annotation label must be a string when provided");
  }
  if (annotation.radius !== undefined) {
    if (
      typeof annotation.radius !== "number" ||
      !Number.isFinite(annotation.radius) ||
      annotation.radius <= 0 ||
      annotation.radius > 1
    ) {
      throw new RangeError("Annotation radius must be finite and within (0, 1]");
    }
  } else if (annotation.kind === "circle" && points.length < 2) {
    throw new RangeError("Circle annotation requires either 2 points or a positive radius");
  }

  return Object.freeze({
    id,
    kind: annotation.kind,
    startFrame,
    endFrame,
    points,
    colorHex: annotation.colorHex,
    ...(annotation.label !== undefined ? { label: annotation.label } : {}),
    ...(annotation.radius !== undefined ? { radius: annotation.radius } : {}),
  });
}

export function validateCoachingComment(comment: CoachingComment): CoachingComment {
  if (comment === null || typeof comment !== "object") {
    throw new TypeError("Coaching comment must be an object");
  }
  const id = requireNonBlankString(comment.id, "comment.id");
  const frameIndex = asFrameIndex(comment.frameIndex);
  if (!ALLOWED_AUTHOR_ROLES.has(comment.authorRole)) {
    throw new TypeError(`Unsupported comment authorRole: ${String(comment.authorRole)}`);
  }
  const createdAt = requireNonBlankString(comment.createdAt, "comment.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new RangeError("comment.createdAt must be a valid ISO timestamp");
  }

  if (comment.kind === "text") {
    const text = requireNonBlankString(comment.text, "comment.text");
    return Object.freeze({
      id,
      kind: "text",
      frameIndex,
      authorRole: comment.authorRole,
      createdAt,
      text,
    });
  }
  if (comment.kind === "voice_note") {
    if (
      typeof comment.audioDurationSec !== "number" ||
      !Number.isFinite(comment.audioDurationSec) ||
      comment.audioDurationSec <= 0
    ) {
      throw new RangeError("voice_note comment audioDurationSec must be positive and finite");
    }
    if (comment.text !== undefined && typeof comment.text !== "string") {
      throw new TypeError("voice_note comment text must be a string when provided");
    }
    return Object.freeze({
      id,
      kind: "voice_note",
      frameIndex,
      authorRole: comment.authorRole,
      createdAt,
      audioDurationSec: comment.audioDurationSec,
      ...(comment.text !== undefined ? { text: comment.text } : {}),
    });
  }
  throw new TypeError(
    `Unsupported coaching comment kind: ${String((comment as { kind: unknown }).kind)}`,
  );
}

export function addAnnotation(
  annotations: readonly DrawingAnnotation[],
  annotation: DrawingAnnotation,
): readonly DrawingAnnotation[] {
  const validated = validateDrawingAnnotation(annotation);
  if (annotations.some((existing) => existing.id === validated.id)) {
    throw new RangeError(`Duplicate drawing annotation id "${validated.id}"`);
  }
  return Object.freeze([...annotations, validated]);
}

export function removeAnnotation(
  annotations: readonly DrawingAnnotation[],
  id: string,
): readonly DrawingAnnotation[] {
  requireNonBlankString(id, "id");
  return Object.freeze(annotations.filter((annotation) => annotation.id !== id));
}

export function visibleAnnotationsAtFrame(
  annotations: readonly DrawingAnnotation[],
  frameIndex: number,
): readonly DrawingAnnotation[] {
  const targetFrame = asFrameIndex(frameIndex);
  return Object.freeze(
    annotations.filter(
      (annotation) => annotation.startFrame <= targetFrame && targetFrame <= annotation.endFrame,
    ),
  );
}

export function addComment(
  comments: readonly CoachingComment[],
  comment: CoachingComment,
): readonly CoachingComment[] {
  const validated = validateCoachingComment(comment);
  if (comments.some((existing) => existing.id === validated.id)) {
    throw new RangeError(`Duplicate coaching comment id "${validated.id}"`);
  }
  return Object.freeze([...comments, validated]);
}

export function removeComment(
  comments: readonly CoachingComment[],
  id: string,
): readonly CoachingComment[] {
  requireNonBlankString(id, "id");
  return Object.freeze(comments.filter((comment) => comment.id !== id));
}

export function commentsAtFrame(
  comments: readonly CoachingComment[],
  frameIndex: number,
): readonly CoachingComment[] {
  const targetFrame = asFrameIndex(frameIndex);
  return Object.freeze(comments.filter((comment) => comment.frameIndex === targetFrame));
}
