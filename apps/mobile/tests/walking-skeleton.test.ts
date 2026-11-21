import { readFileSync } from "node:fs";
import { asMeters, validateContract } from "@sports-motion/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
  buildSkeletonPreview,
  createLocalCapture,
  WalkingSkeletonMobileClient,
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function captureInput() {
  const pose2d = fixture("pose2d");
  const calibration = fixture("calibration.dlt");
  if (!validateContract("pose2d", pose2d) || !validateContract("calibration", calibration)) {
    throw new Error("Invalid capture fixtures");
  }
  return {
    capture_id: "capture-local",
    views: [
      { ...pose2d, contract_version: "1.0.0", view_id: "side" },
      { ...pose2d, contract_version: "1.0.0", view_id: "rear_oblique" },
    ],
    calibration: { ...calibration, contract_version: "1.0.0" },
    movement: "running" as const,
    events: [],
  };
}

const client = new WalkingSkeletonMobileClient({
  apiBaseUrl: "https://api.example",
  teamId: "team",
  authToken: "session",
});

afterEach(() => vi.unstubAllGlobals());

test("creates a serializable capture and rejects invalid observations, camera pairs and events", () => {
  const input = captureInput();
  const capture = createLocalCapture(input);
  expect(JSON.parse(JSON.stringify(capture))).toEqual({ ...input, contract_version: "1.0.0" });
  expect(() => createLocalCapture({ ...input, capture_id: "" })).toThrow("Invalid local capture");
  expect(() => createLocalCapture({ ...input, views: [input.views[0]] })).toThrow(
    "Invalid local capture",
  );
  expect(() => createLocalCapture({ ...input, views: [input.views[0], input.views[0]] })).toThrow(
    "Invalid local capture",
  );
  expect(() =>
    createLocalCapture({
      ...input,
      views: [input.views[0], { ...input.views[1], view_id: "unknown" }],
    }),
  ).toThrow("Invalid local capture");
  expect(() =>
    createLocalCapture({ ...input, views: [{ ...input.views[0], unit: "m" }, input.views[1]] }),
  ).toThrow("Invalid local capture");
  expect(() => createLocalCapture({ ...input, events: [{ event_id: "unknown" }] })).toThrow(
    "Invalid local capture",
  );
});

test("projects metric landmarks and connects visible joints by captured frame index", () => {
  const pose = fixture("pose3d.world");
  if (!validateContract("pose3d", pose)) {
    throw new Error("Invalid pose fixture");
  }
  const first = buildSkeletonPreview(pose, 0);
  expect(first.points[0]).toEqual({
    landmarkId: "right_hip",
    x: asMeters(0.15 * Math.cos(Math.PI / 6) - 0.08 * Math.sin(Math.PI / 6)),
    y: asMeters(-0.68),
  });
  expect(first.segments).toEqual([[0, 1]]);
  expect(buildSkeletonPreview(pose, 2)).toMatchObject({
    points: [{ landmarkId: "right_hip" }],
    segments: [],
  });
  expect(() => buildSkeletonPreview(pose, 1)).toThrow("Unknown skeleton frame");
  const relative = fixture("pose3d.hip");
  if (!validateContract("pose3d", relative)) {
    throw new Error("Invalid relative pose fixture");
  }
  expect(() => buildSkeletonPreview(relative, 0)).toThrow("CalibratedWorld3D");
});

test("rejects failed uploads and malformed pose and kinematics responses", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 422 }));
  vi.stubGlobal("fetch", fetch);
  const capture = createLocalCapture(captureInput());
  await expect(client.uploadAndAnalyze(capture)).rejects.toThrow("HTTP 422");
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe(`https://api.example/teams/team/trials/${capture.views[0].trial_id}/analyze`);
  expect(init.headers.Authorization).toBe("Bearer session");
  expect(JSON.parse(init.body)).toMatchObject({
    capture_id: capture.capture_id,
    analysis_job_id: capture.capture_id,
  });

  const pose = fixture("pose3d.world");
  const metrics = fixture("kinematic_metrics");
  if (!validateContract("pose3d", pose) || !validateContract("kinematic_metrics", metrics)) {
    throw new Error("Invalid analysis fixtures");
  }
  const receipt = {
    analysis_revision_id: metrics.analysis_revision_id,
    evidence_snapshot_id: "evidence",
    evidence_registry_version: "registry",
    non_diagnostic_flag: true,
    disclaimer_text_ja: "診断目的ではありません。",
    pose3d: {
      ...pose,
      contract_version: "1.0.0",
      provenance: { ...pose.provenance, coordinate_revision_id: capture.capture_id },
    },
    kinematic_metrics: { ...metrics, contract_version: "1.0.0" },
  };
  fetch
    .mockResolvedValueOnce(Response.json({ ...receipt, pose3d: {} }))
    .mockResolvedValueOnce(Response.json({ ...receipt, kinematic_metrics: {} }))
    .mockResolvedValueOnce(Response.json(receipt));
  await expect(client.uploadAndAnalyze(capture)).rejects.toThrow(
    "Invalid Walking Skeleton analysis response",
  );
  await expect(client.uploadAndAnalyze(capture)).rejects.toThrow(
    "Invalid Walking Skeleton analysis response",
  );
  await expect(client.uploadAndAnalyze(capture)).resolves.toMatchObject(receipt);
});

test("issues a URL on the share web origin and rejects a missing token", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ shareLinkId: "link", token: "token&signed" }, { status: 201 }),
    )
    .mockResolvedValueOnce(Response.json({ shareLinkId: "link" }, { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  const input = {
    teamId: "team",
    analysisRevisionId: "analysis",
    evidenceSnapshotId: "evidence",
    expiresAt: 1_800_000_000_000,
    shareWebBaseUrl: "https://share.example/",
  };
  await expect(client.issueShareUrl(input)).resolves.toEqual({
    shareLinkId: "link",
    token: "token&signed",
    shareUrl: "https://share.example/share/link?token=token%26signed",
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.example/teams/team/share-links");
  await expect(client.issueShareUrl(input)).rejects.toThrow(
    "Invalid Walking Skeleton share link response",
  );
});
