import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import { once } from "node:events";
import {
  asFrameIndex,
  asPixels,
  asViewId,
  type CoordinateRevision,
  validateContract,
} from "@sports-motion/contracts";
import {
  buildPointMoveRevision,
  buildUndoRevision,
  inspectPose2DQuality,
} from "@sports-motion/editing";
import { test, vi } from "vitest";
import {
  AccessPolicy,
  type AnalysisReceipt,
  MemoryStateStore,
  type RevisionCommitReceipt,
  startApiServer,
  UvMotionWorker,
} from "../src/index.js";
import { calibratedPayload, state, trialId } from "./calibrated-fixture.js";

test("commits immutable revisions and recomputes a calibrated capture through the Python CLI", async () => {
  const initial = state();
  initial.memberships.push({ userId: "admin-a", teamId: "a", role: "OrgAdmin", active: true });
  const store = new MemoryStateStore(initial);
  const key = createSecretKey(Buffer.alloc(32, 54));
  const worker = new UvMotionWorker();
  const calls = vi.spyOn(worker, "analyze");
  const server = await startApiServer({
    policy: new AccessPolicy(store, key),
    worker,
    authenticate: ({ headers }) => headers.authorization?.replace(/^Bearer /u, ""),
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/teams/a/trials/${trialId}`;
  const post = (action: string, body: unknown, user: string | undefined = "coach-a") =>
    fetch(`${base}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(user && { Authorization: `Bearer ${user}` }),
      },
      body: JSON.stringify(body),
    });
  const submission = (revision: CoordinateRevision, jobId = revision.revision_id) => ({
    revision,
    expected_head: revision.expected_head,
    analysis_job_id: jobId,
  });

  try {
    const payload = calibratedPayload();
    const side = payload.views[0];
    const outlier = side?.frames[8]?.landmarks.find(
      ({ landmark_id }) => landmark_id === "right_ankle_left_malleolus",
    );
    assert.ok(outlier && side);
    const cleanX = asPixels(outlier.x);
    outlier.x += 64;
    outlier.confidence = 0.3;
    assert.ok(validateContract("pose2d", side));
    const rawBytes = JSON.stringify(payload.views);
    const initialResponse = await post("analyze", payload);
    assert.equal(initialResponse.status, 201);
    const baseline: AnalysisReceipt = await initialResponse.json();
    assert.equal(baseline.pose3d.coordinate_frame, "CalibratedWorld3D");
    assert.deepEqual(inspectPose2DQuality(side)[8]?.anomalyFlags, [
      "low_confidence",
      "acceleration_spike",
    ]);

    const move = {
      frameIndex: asFrameIndex(8),
      landmarkId: outlier.landmark_id,
      x: cleanX,
      y: asPixels(outlier.y),
    };
    const edit = buildPointMoveRevision(
      side,
      { revisionId: "edit-a", expectedHead: payload.raw_revision_id },
      [move],
    );
    const before = store.read();
    for (const user of ["coach-b", "guardian-a", "athlete-other", "anonymous-share-viewer", ""]) {
      assert.equal((await post("revisions", submission(edit), user)).status, 404);
    }
    const badView = buildPointMoveRevision(
      { ...side, view_id: asViewId("other-camera") },
      { revisionId: "bad-view", expectedHead: payload.raw_revision_id },
      [move],
    );
    assert.equal((await post("revisions", submission(badView))).status, 422);
    assert.equal(calls.mock.calls.length, 1);
    assert.deepEqual(store.read(), before);

    calls.mockRejectedValueOnce(new Error("Worker temporarily unavailable"));
    assert.equal((await post("revisions", submission(edit))).status, 500);
    assert.deepEqual(store.read(), before);
    const pair = await Promise.all([
      post("revisions", submission(edit)),
      post("revisions", submission(edit), "athlete-a"),
    ]);
    assert.deepEqual(pair.map(({ status }) => status).sort(), [200, 201]);
    const [first, retry] = await Promise.all(
      pair.map((response) => response.json() as Promise<RevisionCommitReceipt>),
    );
    assert.ok(first && retry);
    assert.deepEqual(first, retry);
    assert.equal(calls.mock.calls.length, 3);
    assert.equal(first.coordinate_revision_id, edit.revision_id);
    assert.equal(first.current_head, edit.revision_id);
    assert.equal(first.pose3d.provenance.coordinate_revision_id, edit.revision_id);
    assert.equal(first.kinematic_metrics.analysis_revision_id, first.analysis_revision_id);
    assert.ok(first.recompute_ms <= 5000, `Recompute took ${first.recompute_ms} ms`);
    assert.notEqual(first.analysis_revision_id, baseline.analysis_revision_id);
    assert.notEqual(first.evidence_snapshot_id, baseline.evidence_snapshot_id);
    assert.equal(JSON.stringify(calls.mock.calls[2]?.[0].views), rawBytes);
    assert.deepEqual(calls.mock.calls[2]?.[0].revisions, [edit]);

    const kneeAtContact = (result: AnalysisReceipt | RevisionCommitReceipt) => {
      const metric = result.kinematic_metrics.scalar_metrics.find(
        ({ metric_id, event_id }) =>
          metric_id === "run_knee_flexion_extension_angle" && event_id === "run_initial_contact",
      );
      assert.ok(metric?.value_or_null != null && metric.unit === "deg");
      return metric.value_or_null;
    };
    // The fixture translates rigid segments: the shank tilts +0.16 m over a 0.4 m vertical drop.
    const expectedDeg = (Math.atan2(0.16, 0.4) * 180) / Math.PI;
    const errorBefore = Math.abs(kneeAtContact(baseline) - expectedDeg);
    const errorAfter = Math.abs(kneeAtContact(first) - expectedDeg);
    const stabilityBefore = baseline.pose3d.bone_length_stability_mm;
    const stabilityAfter = first.pose3d.bone_length_stability_mm;
    assert.ok(stabilityBefore != null && stabilityAfter != null);
    assert.ok(stabilityBefore > 1 && stabilityAfter < 0.001);
    assert.ok(
      errorBefore > 0.1 && errorAfter < 0.001,
      JSON.stringify({ expectedDeg, errorBefore, errorAfter }),
    );

    const edited = store.read();
    const stale = buildPointMoveRevision(
      side,
      { revisionId: "stale-a", expectedHead: payload.raw_revision_id },
      [move],
    );
    const reused = buildPointMoveRevision(
      side,
      { revisionId: edit.revision_id, expectedHead: payload.raw_revision_id },
      [{ ...move, x: asPixels(cleanX + 1) }],
    );
    for (const rejected of [stale, reused]) {
      assert.equal((await post("revisions", submission(rejected))).status, 409);
    }
    const wrongJob = buildUndoRevision(side, {
      revisionId: "undo-a",
      expectedHead: edit.revision_id,
    });
    assert.equal(
      (await post("revisions", submission(wrongJob, payload.analysis_job_id))).status,
      409,
    );
    assert.deepEqual(store.read(), edited);
    assert.equal(calls.mock.calls.length, 3);

    const undo = buildUndoRevision(side, { revisionId: "undo-a", expectedHead: edit.revision_id });
    const undoneResponse = await post("revisions", submission(undo), "admin-a");
    assert.equal(undoneResponse.status, 201);
    const undone: RevisionCommitReceipt = await undoneResponse.json();
    assert.equal(undone.current_head, undo.revision_id);
    assert.ok(undone.recompute_ms <= 5000, `Undo recompute took ${undone.recompute_ms} ms`);
    assert.equal(undone.pose3d.provenance.coordinate_revision_id, undo.revision_id);
    assert.deepEqual(undone.pose3d.frames, baseline.pose3d.frames);
    assert.equal(undone.pose3d.bone_length_stability_mm, stabilityBefore);
    assert.deepEqual(
      undone.kinematic_metrics.scalar_metrics,
      baseline.kinematic_metrics.scalar_metrics,
    );
    assert.deepEqual(
      undone.kinematic_metrics.normalized_waveforms,
      baseline.kinematic_metrics.normalized_waveforms,
    );
    assert.equal(JSON.stringify(calls.mock.calls[3]?.[0].views), rawBytes);
    assert.deepEqual(calls.mock.calls[3]?.[0].revisions, [edit, undo]);

    const after = store.read();
    assert.equal(after.analyses.length, 3);
    assert.equal(after.evidence.length, 3);
    assert.deepEqual(after.analyses.slice(0, 2), edited.analyses);
    assert.deepEqual(after.evidence.slice(0, 2), edited.evidence);
    assert.equal(JSON.stringify(after.motionJobs?.[0]?.captureInputs?.views), rawBytes);
    assert.deepEqual(
      after.motionJobs?.slice(1).map(({ coordinateCommit }) => coordinateCommit?.revision),
      [edit, undo],
    );
    const replay = await post("revisions", submission(edit, "another-retry-job"));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ...first, current_head: undo.revision_id });
    assert.deepEqual(store.read(), after);
    assert.equal(calls.mock.calls.length, 4);
    console.info(
      JSON.stringify({
        fixture: "synthetic calibrated two-camera run, ankle outlier at frame 8",
        calibration: payload.calibration.calibration_id,
        pipeline: first.pose3d.provenance.pipeline_version,
        filter: first.pose3d.provenance.filter_spec_version,
        edit_recompute_ms: first.recompute_ms,
        undo_recompute_ms: undone.recompute_ms,
        bone_length_sd_mm: [stabilityBefore, stabilityAfter],
        knee_contact_error_deg: [errorBefore, errorAfter],
      }),
    );
  } finally {
    server.close();
    await once(server, "close");
  }
}, 90_000);
