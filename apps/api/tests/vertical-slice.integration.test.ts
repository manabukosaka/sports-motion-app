import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { validateContract } from "@sports-motion/contracts";
import { renderShareReportHtml } from "@sports-motion/share-web";
import { test, vi } from "vitest";
import {
  AccessPolicy,
  type AnalysisReceipt,
  MemoryStateStore,
  type MotionWorker,
  startApiServer,
  UvMotionWorker,
} from "../src/index.js";
import { calibratedPayload, state, trialId } from "./calibrated-fixture.js";

test("analyzes calibrated observations with Python and renders the signed share snapshot", async () => {
  const initial = state();
  const store = new MemoryStateStore(initial);
  const issuedAt = Date.parse("2026-11-21T00:00:00.000Z");
  const key = createSecretKey(Buffer.alloc(32, 47));
  const worker = new UvMotionWorker();
  const calls = vi.spyOn(worker, "analyze");
  const policy = new AccessPolicy(store, key, () => issuedAt);
  const server = await startApiServer({
    policy,
    authenticate: ({ headers }) => headers.authorization?.replace(/^Bearer /, ""),
    worker,
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `/teams/a/trial-videos/${trialId}/analyze`;
  const post = (path: string, value: unknown, user?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(user && { Authorization: `Bearer ${user}` }),
      },
      body: JSON.stringify(value),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: "Bearer coach-a" } });
  try {
    const payload = calibratedPayload();
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024);
    for (const user of ["coach-b", "guardian-a", "athlete-other", undefined]) {
      assert.equal((await post(path, payload, user)).status, 404);
    }
    const invalid = structuredClone(payload);
    const left = invalid.views[0];
    assert.ok(left);
    left.unit = "m";
    assert.equal((await post(path, invalid, "coach-a")).status, 422);
    assert.equal(
      (await post(path, { ...payload, events: [{ event_id: "unknown" }] }, "coach-a")).status,
      422,
    );
    assert.equal(calls.mock.calls.length, 0);
    assert.deepEqual(store.read(), initial);

    // Keep the chunked request open after crossing the limit to verify an immediate response.
    const upload = request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer coach-a" },
    });
    try {
      const response = once(upload, "response");
      upload.setTimeout(5_000, () =>
        upload.destroy(new Error("Oversized request was not aborted")),
      );
      upload.write(Buffer.alloc(2 * 1024 * 1024 + 1));
      const [tooLarge] = await response;
      assert.equal(tooLarge.statusCode, 413);
      assert.equal(tooLarge.headers.connection, "close");
      tooLarge.resume();
      await once(tooLarge, "end");
    } finally {
      upload.destroy();
    }
    assert.equal(
      (await post("/teams/a/share-links", { oversized: "a".repeat(64 * 1024) }, "coach-a")).status,
      413,
    );

    const unsynchronized = structuredClone(payload);
    const first = unsynchronized.views[0]?.frames[0];
    assert.ok(first);
    first.timestamp_sec += 1e-3;
    assert.equal((await post(path, unsynchronized, "coach-a")).status, 422);
    assert.deepEqual(store.read(), initial);
    assert.equal(calls.mock.calls.length, 1);

    const [firstResponse, duplicateResponse] = await Promise.all([
      post(path, payload, "coach-a"),
      post(path, payload, "coach-a"),
    ]);
    assert.deepEqual([firstResponse.status, duplicateResponse.status].sort(), [200, 201]);
    const [created, repeated] =
      firstResponse.status === 201
        ? [firstResponse, duplicateResponse]
        : [duplicateResponse, firstResponse];
    const analysis: AnalysisReceipt = await created.json();
    assert.deepEqual(await repeated.json(), analysis);
    assert.equal(calls.mock.calls.length, 2);
    assert.ok(validateContract("pose3d", analysis.pose3d));
    assert.ok(validateContract("kinematic_metrics", analysis.kinematic_metrics));
    assert.equal(analysis.pose3d.coordinate_frame, "CalibratedWorld3D");
    assert.equal(analysis.pose3d.is_metric_calibrated, true);
    assert.equal(analysis.pose3d.contract_version, "1.0.0");
    assert.equal(analysis.pose3d.frames.length, 80);
    const hip = analysis.pose3d.frames[0].landmarks.find(
      ({ landmark_id }) => landmark_id === "right_hip",
    );
    assert.ok(hip?.y != null && Math.abs(hip.y - 1) < 1e-3);
    assert.ok(
      analysis.kinematic_metrics.scalar_metrics.some((metric) => metric.value_or_null !== null),
    );

    const persisted = await get(`/teams/a/analysis-revisions/${analysis.analysis_revision_id}`);
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json().then(({ pose3d, summary }) => ({ pose3d, summary })), {
      pose3d: analysis.pose3d,
      summary: analysis.kinematic_metrics,
    });
    const evidence = await get(`/teams/a/evidence-snapshots/${analysis.evidence_snapshot_id}`);
    assert.equal(evidence.status, 200);
    assert.match(await evidence.text(), new RegExp(analysis.analysis_revision_id));
    assert.equal(
      (await post(path, { ...payload, movement: "jump_landing" }, "coach-a")).status,
      409,
    );
    assert.equal(
      (await post(path, { ...unsynchronized, analysis_job_id: "job-b" }, "coach-a")).status,
      409,
    );
    assert.equal(calls.mock.calls.length, 2);

    const link = await post(
      "/teams/a/share-links",
      {
        analysisRevisionId: analysis.analysis_revision_id,
        evidenceSnapshotId: analysis.evidence_snapshot_id,
        expiresAt: issuedAt + 60_000,
      },
      "coach-a",
    );
    assert.equal(link.status, 201);
    const { shareLinkId, token } = await link.json();
    const shared = await fetch(`${base}/share/${shareLinkId}?token=${encodeURIComponent(token)}`);
    assert.equal(shared.status, 200);
    const snapshot: unknown = await shared.json();
    assert.ok(validateContract("share_report", snapshot));
    assert.equal(snapshot.non_diagnostic_flag, true);
    assert.equal(snapshot.analysis_revision_id, analysis.analysis_revision_id);
    assert.equal(snapshot.evidence_registry_version, analysis.evidence_registry_version);
    assert.deepEqual(snapshot.kinematic_summary, analysis.kinematic_metrics);
    assert.deepEqual(snapshot.evidence_comparisons, []);
    const html = renderShareReportHtml(snapshot);
    assert.ok(html.includes(snapshot.disclaimer_text_ja));
    assert.ok(html.includes(`data-analysis-revision-id="${analysis.analysis_revision_id}"`));
    assert.equal(store.read().analyses.length, 1);
    assert.equal(store.read().evidence.length, 1);
    const replay = await post(path, payload, "athlete-a");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), analysis);
    assert.equal(calls.mock.calls.length, 2);

    const priorResult = await calls.mock.results[1]?.value;
    assert.ok(priorResult);
    const secondTrial = {
      ...payload,
      capture_id: "capture-other",
      views: payload.views.map((view) => ({ ...view, trial_id: "trial-other" })),
    };
    const invalidWorker: MotionWorker = {
      async analyze(request) {
        return {
          ...priorResult,
          kinematic_metrics: {
            ...priorResult.kinematic_metrics,
            analysis_revision_id: request.analysis_revision_id,
          },
          non_diagnostic_flag: false as never,
        };
      },
    };
    await assert.rejects(
      policy.analyzeTrial("athlete-other", "a", "trial-other", secondTrial, invalidWorker),
      /invalid analysis result/u,
    );
    assert.equal(store.read().analyses.length, 1);

    let finishWorker = () => {};
    const ready = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const deferredWorker: MotionWorker = {
      analyze: vi.fn(async (request) => {
        await ready;
        return {
          ...priorResult,
          kinematic_metrics: {
            ...priorResult.kinematic_metrics,
            analysis_revision_id: request.analysis_revision_id,
          },
        };
      }),
    };
    const revokedCaller = policy.analyzeTrial(
      "athlete-other",
      "a",
      "trial-other",
      secondTrial,
      deferredWorker,
    );
    const allowedCaller = policy.analyzeTrial(
      "coach-a",
      "a",
      "trial-other",
      secondTrial,
      deferredWorker,
    );
    store.update((draft) => {
      draft.memberships = draft.memberships.filter((member) => member.userId !== "athlete-other");
    });
    finishWorker();
    assert.equal(await revokedCaller, undefined);
    const second = await allowedCaller;
    assert.ok(second?.created);
    assert.notEqual(second.receipt.analysis_revision_id, analysis.analysis_revision_id);
    assert.equal(store.read().analyses.length, 2);
    assert.equal(store.read().evidence.length, 2);
    assert.equal(vi.mocked(deferredWorker.analyze).mock.calls.length, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
}, 90_000);
