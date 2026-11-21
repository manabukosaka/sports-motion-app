import { readFileSync } from "node:fs";
import {
  asFrameIndex,
  asPixels,
  asSeconds,
  type CoordinateRevision,
  validateContract,
} from "@sports-motion/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { computeLoupeViewport, EditingStudioController } from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function rawPose() {
  const raw = fixture("pose2d");
  if (!validateContract("pose2d", raw)) {
    throw new TypeError("Invalid editing fixture");
  }
  return raw;
}

const move = {
  frameIndex: asFrameIndex(2),
  landmarkId: "right_knee",
  x: asPixels(500),
  y: asPixels(700),
};
const range = { startFrame: asFrameIndex(2), endFrame: asFrameIndex(2) };

afterEach(() => vi.unstubAllGlobals());

test("stages edits, inspects the effective pose and closes redo when a new edit follows undo", () => {
  const raw = rawPose();
  const studio = new EditingStudioController(raw, { rawRevisionId: "raw" });
  expect(studio.currentHead).toBe("raw");
  expect(studio.canUndo).toBe(false);
  expect(studio.canRedo).toBe(false);
  expect(studio.inspectionTimeline[1]?.anomalyFlags).toContain("missing_landmark");
  const edit = studio.previewEdit("edit", [move]);
  expect(edit.parent_revision_id).toBe("raw");
  expect(studio.inspectionTimeline[1]?.anomalyFlags).not.toContain("missing_landmark");
  expect(studio.canUndo).toBe(true);
  studio.undo("undo");
  expect(studio.canRedo).toBe(true);
  expect(studio.effectivePose2d).toEqual(raw);
  studio.redo("redo");
  expect(studio.effectivePose2d.frames[1]?.landmarks[1]).toMatchObject({
    x: 500,
    source: "manual_edit",
  });
  studio.undo("undo-again");
  studio.swapLeftRight("swap", range, ["knee"]);
  expect(studio.currentHead).toBe("swap");
  expect(studio.canRedo).toBe(false);
  expect(() => studio.redo("closed")).toThrow(RangeError);
  expect(studio.rawPose2d).toEqual(raw);
  const restored = new EditingStudioController(raw, { revisions: [...studio.revisions, edit] });
  expect(restored.currentHead).toBe("swap");
  expect(restored.effectivePose2d).toEqual(studio.effectivePose2d);
});

test("stages interpolation using visible anchors on both sides", () => {
  const raw = rawPose();
  raw.frames.push({
    ...raw.frames[0],
    frame_index: asFrameIndex(4),
    timestamp_sec: asSeconds(0.04),
  });
  const studio = new EditingStudioController(raw);
  studio.interpolateRange("fill", { ...range, landmarkId: "right_knee" });
  expect(studio.effectivePose2d.frames[1]?.landmarks[1]).toMatchObject({
    source: "spline_interpolated",
    missing_reason: null,
  });
});

test("keeps the loupe and zoomed source in bounds and clears the fingertip at every edge", () => {
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [8, 8],
    [300, 20],
  ] as const) {
    for (const x of [0, width / 2, width]) {
      for (const y of [0, height / 2, height]) {
        const { viewport, source, focalPoint, zoom, fingertipRadius } = computeLoupeViewport(
          x,
          y,
          width,
          height,
        );
        for (const rect of [viewport, source]) {
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width);
          expect(rect.y + rect.height).toBeLessThanOrEqual(height);
        }
        const dx = Math.max(viewport.x - x, 0, x - viewport.x - viewport.width);
        const dy = Math.max(viewport.y - y, 0, y - viewport.y - viewport.height);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(fingertipRadius - 1e-12);
        expect(source.x + focalPoint.x / zoom).toBeCloseTo(x);
        expect(source.y + focalPoint.y / zoom).toBeCloseTo(y);
        expect(source.width * zoom).toBeCloseTo(viewport.width);
      }
    }
  }
  expect(() => computeLoupeViewport(0, 0, 0, 20)).toThrow(RangeError);
});

test("commits staged revisions in order and retries only unacknowledged revisions with stable IDs", async () => {
  const raw = rawPose();
  const pose3d = fixture("pose3d.world");
  const metrics = fixture("kinematic_metrics");
  if (!validateContract("pose3d", pose3d) || !validateContract("kinematic_metrics", metrics)) {
    throw new TypeError("Invalid recompute fixtures");
  }
  const studio = new EditingStudioController(raw, { rawRevisionId: "raw" });
  studio.previewEdit("edit", [move]);
  studio.undo("undo");
  const calls: string[] = [];
  const post = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe(`https://example.test/teams/team%20a/trials/${raw.trial_id}/revisions`);
    expect(options.headers).toMatchObject({ Authorization: "Bearer token" });
    const payload: {
      revision: CoordinateRevision;
      analysis_job_id: string;
      expected_head: string;
    } = JSON.parse(String(options.body));
    const id = payload.revision.revision_id;
    calls.push(id);
    expect(payload.analysis_job_id).toBe(id);
    expect(payload.expected_head).toBe(id === "edit" ? "raw" : "edit");
    if (calls.length === 2) {
      return new Response(null, { status: 503 });
    }
    const provenance = { ...pose3d.provenance, coordinate_revision_id: id };
    return Response.json({
      analysis_revision_id: `analysis-${id}`,
      evidence_snapshot_id: `evidence-${id}`,
      coordinate_revision_id: id,
      current_head: id,
      recompute_ms: 40,
      pose3d: { ...pose3d, provenance },
      kinematic_metrics: { ...metrics, provenance, analysis_revision_id: `analysis-${id}` },
    });
  });
  vi.stubGlobal("fetch", post);
  const api = { apiBaseUrl: "https://example.test/", teamId: "team a", authToken: "token" };
  const first = studio.commitRevisionAndRecompute(api);
  expect(studio.commitRevisionAndRecompute(api)).toBe(first);
  await expect(first).rejects.toThrow("503");
  await expect(studio.commitRevisionAndRecompute(api)).resolves.toMatchObject({
    current_head: "undo",
  });
  await expect(studio.commitRevisionAndRecompute(api)).resolves.toBeUndefined();
  expect(calls).toEqual(["edit", "undo", "undo"]);
  expect(studio.effectivePose2d).toEqual(raw);
});
