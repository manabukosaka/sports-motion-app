import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type EvidenceCatalog, validateContract } from "@sports-motion/contracts";
import { loadEvidenceCatalog } from "@sports-motion/evidence";
import { test } from "vitest";
import {
  AccessPolicy,
  type AccessState,
  type AnalysisReceipt,
  MemoryStateStore,
  type MotionWorker,
  startApiServer,
} from "../src/index.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function catalog(version: string, mean: number): EvidenceCatalog {
  const registry = loadEvidenceCatalog();
  const doi = "10.0000/synthetic-api-benchmark";
  const metric_id = "run_knee_flexion_extension_angle";
  registry.evidence_registry_version = version;
  registry.disclaimer_policy.user_facing_text_ja += `（参照版 ${version}）`;
  registry.studies.push({
    id: "synthetic_api_benchmark",
    domain: "running",
    authors: ["Synthetic author"],
    year: 2026,
    journal: "Synthetic fixture",
    title: "Synthetic benchmarks for the API test",
    doi,
    measurement_modality: "optical_mocap",
    population_notes: "Twenty simulated runners",
    metrics_covered: [metric_id],
    extraction_status: "verified_normative",
    comparability_bias_note: "Synthetic fixture only",
  });
  registry.normative_metrics.push({
    metric_id,
    event_id: "run_initial_contact",
    unit: "deg",
    anatomical_plane: "sagittal",
    stat_type: "mean_sd",
    status: "verified_normative",
    sample_size: 20,
    source_doi: doi,
    source_locator: "Synthetic row one",
    cohort_notes: "One trial per simulated runner",
    values: { mean, sd: 4 },
    non_diagnostic_flag: true,
  });
  return registry;
}

test("pins benchmark receipts, checkpoints, and share bytes across a registry upgrade", async () => {
  const kinematics = fixture("kinematic_metrics");
  const pose = fixture("pose3d.world");
  const view = fixture("pose2d");
  const calibration = fixture("calibration.dlt");
  assert.ok(validateContract("kinematic_metrics", kinematics));
  assert.ok(validateContract("pose3d", pose));
  assert.ok(validateContract("pose2d", view));
  assert.ok(
    validateContract("calibration", calibration) && calibration.mode === "dlt_control_poles",
  );
  const trialId = view.trial_id;
  const submission = {
    capture_id: "capture-a",
    analysis_job_id: "job-a",
    movement: "running",
    views: calibration.views.map(({ view_id }) => ({ ...view, view_id })),
    calibration,
    raw_revision_id: pose.provenance.coordinate_revision_id,
    events: kinematics.events,
  };
  const initialCatalog = loadEvidenceCatalog();
  let workerCalls = 0;
  const worker: MotionWorker = {
    async analyze({ analysis_revision_id }) {
      workerCalls += 1;
      return {
        pose3d: pose,
        kinematic_metrics: { ...kinematics, analysis_revision_id, provenance: pose.provenance },
        selected_cutoffs_hz: { pooled: 6 },
        evidence_registry_version: initialCatalog.evidence_registry_version,
        evidence_comparisons: [],
        non_diagnostic_flag: true,
        disclaimer_text_ja: initialCatalog.disclaimer_policy.user_facing_text_ja,
      };
    },
  };
  const state: AccessState = {
    teams: ["a", "b"].map((id) => ({ id, teamId: id, orgId: `org-${id}`, name: id })),
    athletes: ["owner", "other"].map((id) => ({
      id,
      teamId: "a",
      name: id,
      shareConsent: true,
    })),
    trials: [{ id: trialId, teamId: "a", athleteId: "owner", title: "Running" }],
    memberships: [
      { userId: "admin", teamId: "a", role: "OrgAdmin", active: true },
      { userId: "coach", teamId: "a", role: "Coach", active: true },
      { userId: "owner", teamId: "a", role: "Athlete", active: true, athleteId: "owner" },
      { userId: "other", teamId: "a", role: "Athlete", active: true, athleteId: "other" },
      { userId: "guardian", teamId: "a", role: "Guardian", active: true },
      { userId: "unlinked", teamId: "a", role: "Guardian", active: true },
      { userId: "coach-b", teamId: "b", role: "Coach", active: true },
    ],
    guardians: [
      { userId: "guardian", teamId: "a", athleteId: "owner", active: true },
      { userId: "unlinked", teamId: "a", athleteId: "other", active: true },
    ],
    analyses: [],
    evidence: [],
    links: [],
  };
  const store = new MemoryStateStore(state);
  const now = Date.parse("2026-11-21T00:00:00Z");
  const policy = new AccessPolicy(store, createSecretKey(Buffer.alloc(32, 52)), () => now);
  const firstCatalog = catalog("1.0.0", 20);
  policy.setEvidenceCatalog(firstCatalog);
  firstCatalog.normative_metrics.length = 0;

  const server = await startApiServer({
    policy,
    authenticate: ({ headers }) => headers.authorization?.replace(/^Bearer /, ""),
    worker,
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const get = (path: string, user?: string) =>
      fetch(`${base}${path}`, { headers: user ? { Authorization: `Bearer ${user}` } : {} });
    const post = (path: string, user: string, value: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user}` },
        body: JSON.stringify(value),
      });
    const analyze = `/teams/a/trial-videos/${trialId}/analyze`;
    const response = await post(analyze, "owner", submission);
    assert.equal(response.status, 201);
    const receipt: AnalysisReceipt = await response.json();
    assert.equal(receipt.evidence_registry_version, "1.0.0");
    assert.equal(receipt.evidence_comparisons.length, 1);
    assert.deepEqual(receipt.evidence_comparisons[0]?.reference_values, { mean: 20, sd: 4 });

    const issued = await post("/teams/a/share-links", "coach", {
      analysisRevisionId: receipt.analysis_revision_id,
      evidenceSnapshotId: receipt.evidence_snapshot_id,
      expiresAt: now + 60_000,
    });
    assert.equal(issued.status, 201);
    const { shareLinkId, token } = await issued.json();
    const sharePath = `/share/${shareLinkId}?token=${encodeURIComponent(token)}`;
    const share = await get(sharePath);
    assert.equal(share.status, 200);
    const shareBytes = await share.text();
    const snapshot: unknown = JSON.parse(shareBytes);
    assert.ok(validateContract("share_report", snapshot));
    assert.equal(snapshot.evidence_registry_version, "1.0.0");
    assert.equal(snapshot.disclaimer_text_ja, firstCatalog.disclaimer_policy.user_facing_text_ja);
    assert.deepEqual(snapshot.evidence_comparisons, receipt.evidence_comparisons);

    const snapshotPath = `/teams/a/evidence-snapshots/${receipt.evidence_snapshot_id}`;
    const checkpointsPath = `${snapshotPath}/checkpoints`;
    const evidenceRow = await (await get(snapshotPath, "coach")).json();
    assert.equal(Object.hasOwn(evidenceRow, "checkpoints"), false);
    const pinnedRecord = store.read().evidence[0];
    const checkpointResponse = await get(checkpointsPath, "coach");
    assert.equal(checkpointResponse.status, 200);
    assert.equal(checkpointResponse.headers.get("cache-control"), "private, no-store");
    const checkpointBytes = await checkpointResponse.text();
    const { evidence_snapshot_id, evidence_registry_version, checkpoints } =
      JSON.parse(checkpointBytes);
    assert.equal(evidence_snapshot_id, receipt.evidence_snapshot_id);
    assert.equal(evidence_registry_version, "1.0.0");
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].researcher_detail.z_score, -0.5);
    assert.equal(checkpoints[0].non_diagnostic_flag, true);
    assert.equal(checkpoints[0].disclaimer_text_ja, snapshot.disclaimer_text_ja);

    for (const user of ["admin", "owner", "guardian"]) {
      const authorized = await get(checkpointsPath, user);
      assert.equal(authorized.status, 200, user);
      assert.equal(await authorized.text(), checkpointBytes);
    }
    for (const [path, user] of [
      [checkpointsPath, "other"],
      [checkpointsPath, "unlinked"],
      [checkpointsPath, "coach-b"],
      [checkpointsPath, undefined],
      [`${checkpointsPath}?token=${encodeURIComponent(token)}`, undefined],
      [checkpointsPath.replace("/teams/a/", "/teams/b/"), "coach-b"],
      [`${checkpointsPath}?teamId=b`, "coach"],
    ] as const) {
      const denied = await get(path, user);
      assert.equal(denied.status, 404, `${path} as ${user}`);
      assert.equal(await denied.text(), '{"error":"not_found"}');
    }

    policy.setEvidenceCatalog(catalog("1.1.0", 30));
    const second = await post(analyze, "owner", { ...submission, analysis_job_id: "job-b" });
    assert.equal(second.status, 201);
    const newer: AnalysisReceipt = await second.json();
    assert.equal(newer.evidence_registry_version, "1.1.0");
    assert.notEqual(newer.evidence_snapshot_id, receipt.evidence_snapshot_id);
    assert.deepEqual(newer.evidence_comparisons[0]?.reference_values, { mean: 30, sd: 4 });
    const newerCheckpoints = policy.readEvidenceCheckpoints(
      "coach",
      "a",
      newer.evidence_snapshot_id,
    );
    const detail = newerCheckpoints?.checkpoints[0]?.researcher_detail;
    assert.ok(detail && "z_score" in detail);
    assert.equal(detail.z_score, -3);

    assert.deepEqual(store.read().evidence[0], pinnedRecord);
    assert.deepEqual(await (await get(snapshotPath, "coach")).json(), evidenceRow);
    assert.equal(await (await get(checkpointsPath, "coach")).text(), checkpointBytes);
    assert.equal(await (await get(sharePath)).text(), shareBytes);
    const replay = await post(analyze, "owner", submission);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    assert.equal(workerCalls, 2);
  } finally {
    server.close();
    await once(server, "close");
  }
});
