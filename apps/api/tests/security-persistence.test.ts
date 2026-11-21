import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateContract } from "@sports-motion/contracts";
import { test } from "vitest";
import {
  AccessPolicy,
  type AccessState,
  createBearerAuthenticator,
  type DeletionAuditReceipt,
  FileStateStore,
  issueBearerToken,
  type MediaMethod,
  MemoryStateStore,
  type StateStore,
  signMediaUrl,
  startApiServer,
  verifyBearerToken,
  verifyMediaUrl,
} from "../src/index.js";
import { state, trialId } from "./calibrated-fixture.js";

const now = Date.parse("2026-11-21T00:00:00.000Z");
const clock = () => now;
const key = createSecretKey(Buffer.alloc(32, 61));
const mediaKey = createSecretKey(Buffer.alloc(32, 62));
const identity = { issuer: "sports-motion", audience: "api" };
const athleteName = "Private Athlete Name";
const analysisId = "analysis-a";
const evidenceId = "evidence-a";
const deletePath = "/teams/a/athletes/athlete-a/personal-data";
const mediaPath = `/teams/a/trial-videos/${trialId}/signed-url`;

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function fixtureState() {
  const initial = state();
  const summary = fixture("kinematic_metrics");
  const pose = fixture("pose3d.world");
  const revision = fixture("coordinate_revision.edit");
  assert.ok(validateContract("kinematic_metrics", summary));
  assert.ok(validateContract("pose3d", pose));
  assert.ok(validateContract("coordinate_revision", revision));
  const athlete = initial.athletes.find(({ id }) => id === "athlete-a");
  assert.ok(athlete);
  athlete.name = athleteName;
  initial.athletes.push({ ...athlete, teamId: "b", name: "Foreign athlete" });
  initial.trials.push({ id: trialId, teamId: "b", athleteId: athlete.id, title: "Foreign trial" });
  initial.memberships.push(
    { userId: "admin-a", teamId: "a", role: "OrgAdmin", active: true },
    { userId: "admin-b", teamId: "b", role: "OrgAdmin", active: true },
    { userId: "inactive-admin", teamId: "a", role: "OrgAdmin", active: false },
  );
  for (const teamId of ["a", "b"]) {
    const scope = { teamId, athleteId: athlete.id, trialId };
    initial.analyses.push({
      ...scope,
      id: analysisId,
      summary: { ...summary, analysis_revision_id: analysisId },
      pose3d: pose,
    });
    initial.evidence.push({
      ...scope,
      id: evidenceId,
      analysisRevisionId: analysisId,
      contractVersion: summary.contract_version,
      registryVersion: "1.0.0",
      nonDiagnostic: true,
      disclaimerTextJa: "This report is non-diagnostic.",
      comparisons: [],
    });
  }
  initial.motionJobs = ["a", "b"].map((teamId) => ({
    teamId,
    trialId,
    captureId: "capture-a",
    jobId: "job-a",
    captureDigest: "capture-digest",
    requestDigest: "request-digest",
    coordinateCommit: { revision, recomputeMs: 12 },
  }));
  return initial;
}

function bearer(userId: string) {
  return issueBearerToken({ ...identity, userId, expiresAt: now + 60_000, tokenId: userId }, key);
}

function flipTag(value: string) {
  const last = value.slice(-1);
  return `${value.slice(0, -1)}${last === "A" ? "E" : "A"}`;
}

async function serve(
  store: StateStore<AccessState>,
  run: (base: string, policy: AccessPolicy) => Promise<void>,
) {
  const policy = new AccessPolicy(store, key, clock);
  const server = await startApiServer({
    policy,
    authenticate: createBearerAuthenticator({ ...identity, secret: key, now: clock }),
    mediaSigning: { baseUrl: "https://storage.example.test/videos/", secret: mediaKey, now: clock },
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`, policy);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function send(base: string, path: string, method: string, token?: string, body?: object) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Role": "OrgAdmin",
      "X-User-Id": "admin-a",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

function share(policy: AccessPolicy, teamId = "a") {
  const issued = policy.issue(`admin-${teamId}`, teamId, {
    analysisRevisionId: analysisId,
    evidenceSnapshotId: evidenceId,
    expiresAt: now + 60_000,
  });
  assert.ok(issued);
  const path = `/share/${issued.shareLinkId}?token=${issued.token}`;
  const posePath = `/share/${issued.shareLinkId}/pose3d?token=${issued.token}`;
  return { ...issued, path, posePath };
}

async function expectNotFound(response: Response) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
}

test("restarts with exact persisted state, share bytes and revocations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sports-motion-api-"));
  const path = join(directory, "state.json");
  try {
    const first = new FileStateStore(path, fixtureState());
    const policy = new AccessPolicy(first, key, clock);
    assert.ok(policy.write("coach-a", "a", "TrialVideo", trialId, { title: "Persisted title" }));
    const revoked = share(policy);
    const active = share(policy);
    assert.ok(policy.revoke("admin-a", "a", revoked.shareLinkId));
    const shareBytes = policy.readShare(active.shareLinkId, active.token, {});
    assert.ok(shareBytes);
    const previousBytes = readFileSync(path, "utf8");
    assert.throws(
      () =>
        first.update((draft) => {
          draft.trials = [];
          throw new Error("transaction failed");
        }),
      /transaction failed/u,
    );
    const restarted = new FileStateStore(path, state());
    assert.deepEqual(restarted.read(), first.read());
    assert.equal(readFileSync(path, "utf8"), previousBytes);
    assert.deepEqual(readdirSync(directory), ["state.json"]);
    await serve(restarted, async (base) => {
      assert.equal(await (await send(base, active.path, "GET")).text(), shareBytes);
      await expectNotFound(await send(base, revoked.path, "GET"));
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticates only canonical, unexpired, unrevoked Bearer tokens for this issuer and audience", () => {
  const claims = { ...identity, userId: "coach-a", expiresAt: now + 1000, tokenId: "session-a" };
  const token = issueBearerToken(claims, key);
  const header = `Bearer ${token}`;
  const options = { ...identity, secret: key, now, revokedTokenIds: new Set<string>() };
  assert.deepEqual(verifyBearerToken(header, options), claims);
  for (const overrides of [
    { now: claims.expiresAt },
    { now: claims.expiresAt + 1 },
    { now: Number.NaN },
    { revokedTokenIds: new Set([claims.tokenId]) },
    { issuer: "foreign" },
    { audience: "other-api" },
    { secret: mediaKey },
  ]) {
    assert.equal(verifyBearerToken(header, { ...options, ...overrides }), undefined);
  }
  for (const malformed of [
    undefined,
    token,
    `bearer ${token}`,
    `Bearer  ${token}`,
    `${header}\n`,
    `${header}=`,
    flipTag(header),
  ]) {
    assert.equal(verifyBearerToken(malformed, options), undefined);
  }
  const weakKey = createSecretKey(Buffer.alloc(16, 1));
  assert.throws(() => issueBearerToken(claims, weakKey), TypeError);
  assert.throws(() => verifyBearerToken(header, { ...options, secret: weakKey }), TypeError);
  assert.throws(() => createBearerAuthenticator({ ...identity, secret: weakKey }), TypeError);
});

test("issues scoped video URLs with the persisted trial R/W matrix and bounded TTL", async () => {
  const store = new MemoryStateStore(fixtureState());
  await serve(store, async (base, policy) => {
    const anonymous = share(policy);
    const before = store.read();
    const matrix: [string | undefined, MediaMethod[]][] = [
      [bearer("coach-a"), ["GET", "PUT"]],
      [bearer("admin-a"), ["GET", "PUT"]],
      [bearer("athlete-a"), ["GET", "PUT"]],
      [bearer("guardian-a"), ["GET"]],
      [bearer("athlete-other"), []],
      [bearer("admin-b"), []],
      [bearer("inactive-admin"), []],
      [anonymous.token, []],
      [undefined, []],
    ];
    for (const [actor, allowed] of matrix) {
      for (const method of ["GET", "PUT"] as const) {
        const response = await send(base, mediaPath, "POST", actor, { method });
        if (!allowed.includes(method)) {
          await expectNotFound(response);
          continue;
        }
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const { url, ...metadata } = await response.json();
        const expiresAt = now + 300_000;
        assert.deepEqual(metadata, {
          method,
          object_key: "video.mp4",
          expires_at: new Date(expiresAt).toISOString(),
        });
        assert.deepEqual(verifyMediaUrl(url, { method, now, secret: mediaKey }), {
          teamId: "a",
          trialId,
          method,
          expiresAt,
          objectKey: "video.mp4",
        });
      }
    }
    await expectNotFound(
      await send(base, mediaPath.replace("/a/", "/b/"), "POST", bearer("admin-a"), {
        method: "GET",
      }),
    );
    await expectNotFound(
      await send(base, mediaPath, "POST", bearer("coach-a"), {
        method: "GET",
        object_key: "../video.mp4",
      }),
    );
    const capped = await send(base, mediaPath, "POST", bearer("coach-a"), {
      method: "PUT",
      object_key: "angles/front clip.mp4",
      ttl_seconds: 10_000,
    });
    assert.equal(capped.status, 200);
    const { url, expires_at } = await capped.json();
    assert.equal(expires_at, new Date(now + 900_000).toISOString());
    assert.equal(
      verifyMediaUrl(url, { method: "PUT", now, secret: mediaKey })?.objectKey,
      "angles/front clip.mp4",
    );
    assert.deepEqual(store.read(), before);
    const encodedTrial = await send(
      base,
      "/teams/a/trial-videos/trial%251",
      "PUT",
      bearer("coach-a"),
      {
        athleteId: "athlete-a",
        title: "Percent trial",
      },
    );
    assert.equal(encodedTrial.status, 200);
    await expectNotFound(
      await send(base, "/teams/a/trial-videos/trial%251/signed-url", "POST", bearer("coach-a"), {
        method: "GET",
      }),
    );
  });
});

test("verifies media paths and binds the method, expiry, key, team and trial", () => {
  const claims = {
    teamId: "a",
    trialId,
    method: "GET",
    expiresAt: now + 1000,
    objectKey: "angles/front clip.mp4",
  } as const;
  const baseUrl = "https://storage.example.test/videos";
  const url = signMediaUrl({ ...claims, baseUrl }, mediaKey);
  const opts = { method: claims.method, now, secret: mediaKey };
  const { pathname, search } = new URL(url);
  assert.deepEqual(verifyMediaUrl(`${pathname}${search}`, opts), claims);
  assert.equal(verifyMediaUrl(url, { ...opts, method: "PUT" }), undefined);
  assert.equal(verifyMediaUrl(url, { ...opts, now: claims.expiresAt }), undefined);
  for (const invalid of [
    pathname,
    flipTag(url),
    `${url}&sig=duplicate`,
    `${url}\n`,
    url.replace(`${claims.expiresAt}`, `${claims.expiresAt + 1000}`),
    url.replace("/a/", "/b/"),
    url.replace(trialId, "trial-other"),
    url.replace("front%20clip.mp4", "rear.mp4"),
    url.replace("angles/", "angles/../angles/"),
    url.replace("angles/", "angles/%2e%2e/angles/"),
    url.replace("angles/", "angles/%252e%252e/angles/"),
    url.replace("angles/", "angles/%00/"),
  ]) {
    assert.equal(verifyMediaUrl(invalid, opts), undefined, invalid);
  }
  for (const objectKey of ["../outside.mp4", "angles\\front.mp4", "angles/front\u0000.mp4"]) {
    assert.throws(() => signMediaUrl({ ...claims, baseUrl, objectKey }, mediaKey), TypeError);
  }
  const weakKey = createSecretKey(Buffer.alloc(16, 2));
  assert.throws(() => signMediaUrl({ ...claims, baseUrl }, weakKey), TypeError);
  assert.throws(() => verifyMediaUrl(url, { ...opts, secret: weakKey }), TypeError);
});

test.each([
  "admin-a",
  "athlete-a",
])("erases and revokes atomically when authorized as %s", async (actor) => {
  const directory = mkdtempSync(join(tmpdir(), "sports-motion-delete-"));
  const path = join(directory, "state.json");
  try {
    const store = new FileStateStore(path, fixtureState());
    await serve(store, async (base, policy) => {
      const active = share(policy);
      const revoked = share(policy);
      const foreign = share(policy, "b");
      assert.ok(policy.revoke("admin-a", "a", revoked.shareLinkId));
      const before = store.read();
      for (const sharePath of [active.path, active.posePath, foreign.path]) {
        const response = await send(base, sharePath, "GET");
        assert.equal(response.status, 200);
        await response.text();
      }
      for (const denied of [
        bearer("coach-a"),
        bearer("guardian-a"),
        bearer("athlete-other"),
        bearer("admin-b"),
        bearer("inactive-admin"),
        active.token,
        undefined,
      ]) {
        await expectNotFound(await send(base, deletePath, "DELETE", denied));
        assert.deepEqual(store.read(), before);
      }
      const response = await send(base, deletePath, "DELETE", bearer(actor));
      assert.equal(response.status, 200);
      const receipt: DeletionAuditReceipt = await response.json();
      assert.match(receipt.receiptId, /^[a-f0-9-]{36}$/u);
      assert.deepEqual(receipt, {
        receiptId: receipt.receiptId,
        teamId: "a",
        deletedAt: now,
        removedTrials: 1,
        removedAnalyses: 1,
        revokedShareLinks: 1,
      });
      const recovered = new FileStateStore(path, state()).read();
      assert.deepEqual(recovered.deletionAudits, [receipt]);
      assert.ok(!readFileSync(path, "utf8").includes(athleteName));
      assert.deepEqual(
        recovered.athletes,
        before.athletes.filter(({ teamId, id }) => teamId !== "a" || id !== "athlete-a"),
      );
      assert.deepEqual(
        recovered.trials,
        before.trials.filter(({ teamId, id }) => teamId !== "a" || id !== trialId),
      );
      assert.deepEqual(
        recovered.memberships,
        before.memberships.filter(({ userId }) => userId !== "athlete-a"),
      );
      for (const field of ["analyses", "evidence", "motionJobs", "guardians"] as const) {
        assert.deepEqual(
          recovered[field],
          before[field]?.filter(({ teamId }) => teamId !== "a"),
        );
      }
      for (const issued of [active, revoked]) {
        const link = recovered.links.find(({ id }) => id === issued.shareLinkId);
        assert.ok(link?.revoked);
        assert.equal(link.snapshotJson, "");
        assert.equal(link.pose3dJson, undefined);
        await expectNotFound(await send(base, issued.path, "GET"));
        await expectNotFound(await send(base, issued.posePath, "GET"));
      }
      const untouched = await send(base, foreign.path, "GET");
      assert.equal(untouched.status, 200);
      await untouched.text();
      await expectNotFound(await send(base, deletePath, "DELETE", bearer(actor)));
      await expectNotFound(
        await send(base, mediaPath, "POST", bearer("coach-a"), { method: "GET" }),
      );
      assert.deepEqual(store.read(), recovered);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects oversized requests from headers and mid-stream before the upload ends", async () => {
  const store = new MemoryStateStore(state());
  await serve(store, async (base) => {
    for (const declared of [true, false]) {
      const upload = request(`${base}/teams/a/trial-videos/${trialId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${bearer("coach-a")}`,
          "Content-Type": "application/json",
          ...(declared && { Expect: "100-continue", "Content-Length": 50 * 1024 * 1024 }),
        },
      });
      let continued = false;
      upload.on("continue", () => {
        continued = true;
      });
      try {
        const reply = once(upload, "response");
        upload.setTimeout(3000, () => upload.destroy(new Error("No early rejection")));
        if (declared) {
          upload.flushHeaders();
        } else {
          upload.write(Buffer.alloc(64 * 1024));
          upload.write(Buffer.alloc(1));
        }
        const [response] = await reply;
        assert.equal(response.statusCode, 413);
        assert.equal(response.headers.connection, "close");
        assert.equal(continued, false);
        response.resume();
        await once(response, "end");
        assert.deepEqual(store.read(), state());
      } finally {
        upload.destroy();
      }
    }
  });
});
