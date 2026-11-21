import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createSecretKey } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readCompatibleContract, validateContract } from "@sports-motion/contracts";
import { test } from "vitest";
import {
  AccessPolicy,
  type AccessState,
  createApiServer,
  type EvidenceRecord,
  LifecycleEngine,
  MemoryStateStore,
  type Operation,
  type Principal,
  type Resource,
  type Role,
  type ShareTokenClaims,
  signShareToken,
  verifyShareToken,
} from "../src/index.js";

const key = createSecretKey(Buffer.alloc(32, 17));
const wrongKey = createSecretKey(Buffer.alloc(32, 27));
const issuedAt = Date.parse("2026-11-20T02:30:00.000Z");
const expiresAt = issuedAt + 10000;
function readFixture() {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/fixtures/valid/share_report.synthetic_comparison.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(validateContract("share_report", value));
  return value;
}
const fixture = readFixture();

const resources = [
  ["Team", "teams"],
  ["AthleteProfile", "athlete-profiles"],
  ["TrialVideo", "trial-videos"],
  ["AnalysisRevision", "analysis-revisions"],
  ["EvidenceSnapshot", "evidence-snapshots"],
  ["ShareLink", "share-links"],
] as const satisfies readonly (readonly [Resource, string])[];
const principals = [
  "OrgAdmin",
  "Coach",
  "Athlete",
  "Guardian",
  "AnonymousShareViewer",
  "Unauthenticated",
] as const;
const operations = ["R", "L", "W", "S"] as const;
const teams = ["a", "b", "c"] as const;
type Team = (typeof teams)[number];
type Athlete = "self" | "other";
type Property = "A1" | "A2" | "A3";
type Request = { method?: string; path: string; user?: string; body?: unknown };
type Condition = Record<string, unknown>;

const matrix = {
  OrgAdmin: ["RLW", "RLW", "RLW", "RL", "RL", "RLS"],
  Coach: ["R", "RL", "RLW", "RL", "RL", "RLS"],
  Athlete: ["R", "R", "RLW", "RL", "RL", ""],
  Guardian: ["", "R", "R", "R", "R", ""],
  AnonymousShareViewer: ["", "", "", "", "", ""],
  Unauthenticated: ["", "", "", "", "", ""],
} satisfies Record<Principal, readonly string[]>;

function resourceId(resource: Resource, team: Team, athlete: Athlete) {
  return resource === "Team" ? team : `${team}-${athlete}-${resource}`;
}

function fixtureState() {
  const state: AccessState = {
    memberships: [],
    guardians: [],
    teams: [],
    athletes: [],
    trials: [],
    analyses: [],
    evidence: [],
    links: [],
  };
  for (const team of teams) {
    state.teams.push({
      id: team,
      teamId: team,
      orgId: team === "c" ? "org-2" : "org-1",
      name: `Team ${team}`,
    });
    for (const athlete of ["self", "other"] as const) {
      const athleteId = resourceId("AthleteProfile", team, athlete);
      const trialId = resourceId("TrialVideo", team, athlete);
      const analysisId = resourceId("AnalysisRevision", team, athlete);
      state.athletes.push({ id: athleteId, teamId: team, name: athlete, shareConsent: true });
      state.trials.push({ id: trialId, athleteId, teamId: team, title: "Trial" });
      state.analyses.push({
        id: analysisId,
        athleteId,
        trialId,
        teamId: team,
        summary: {
          ...fixture.kinematic_summary,
          analysis_revision_id: analysisId,
          contract_version: "1.0.0",
          provenance: { ...fixture.kinematic_summary.provenance, contract_version: "1.0.0" },
        },
      });
      state.evidence.push({
        id: resourceId("EvidenceSnapshot", team, athlete),
        athleteId,
        trialId,
        teamId: team,
        analysisRevisionId: analysisId,
        contractVersion: "1.0.0",
        registryVersion: fixture.evidence_registry_version,
        comparisons: fixture.evidence_comparisons,
        nonDiagnostic: true,
        disclaimerTextJa: fixture.disclaimer_text_ja,
      });
    }
  }
  for (const role of principals.slice(0, 4) as Role[]) {
    const athleteId = resourceId("AthleteProfile", "a", "self");
    state.memberships.push(
      { userId: role, teamId: "a", role, active: true, athleteId },
      { userId: `${role}-inactive`, teamId: "a", role, active: false, athleteId },
    );
  }
  state.guardians.push(
    {
      userId: "Guardian",
      teamId: "a",
      athleteId: resourceId("AthleteProfile", "a", "self"),
      active: true,
    },
    {
      userId: "Guardian",
      teamId: "a",
      athleteId: resourceId("AthleteProfile", "a", "other"),
      active: false,
    },
    {
      userId: "Guardian",
      teamId: "b",
      athleteId: resourceId("AthleteProfile", "a", "other"),
      active: true,
    },
  );
  return state;
}

function issueFields(team: Team, athlete: Athlete) {
  return {
    teamId: team,
    analysisRevisionId: resourceId("AnalysisRevision", team, athlete),
    evidenceSnapshotId: resourceId("EvidenceSnapshot", team, athlete),
    expiresAt,
  };
}

async function serve<T>(
  store: MemoryStateStore<AccessState>,
  clock: () => number,
  run: (request: (input: Request) => Promise<Response>) => Promise<T>,
  allowShare?: (claims: Readonly<ShareTokenClaims>) => boolean,
) {
  const credentials = new Map(
    store.read().memberships.map(({ userId }, index) => [`session-${index}`, userId]),
  );
  const sessions = new Map([...credentials].map(([session, user]) => [user, session]));
  const server = createApiServer({
    policy: new AccessPolicy(store, key, clock, allowShare),
    authenticate: (request) =>
      credentials.get((request.headers.authorization ?? "").replace(/^Bearer /u, "")),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await run(({ path, method = "GET", user, body }) => {
      const session = user && sessions.get(user);
      return fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          "X-Team-Id": "a",
          "X-Role": "OrgAdmin",
          "X-User-Id": "OrgAdmin",
          ...(session && { Authorization: `Bearer ${session}` }),
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function check<T>(property: Property, condition: Condition, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('{"property":')) {
      throw error;
    }
    throw new Error(JSON.stringify({ property, ...condition, error: String(error) }), {
      cause: error,
    });
  }
}

async function assertDenied(
  response: Response,
  store: MemoryStateStore<AccessState>,
  prior: AccessState,
) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.deepEqual(store.read(), prior);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

function teamPath(team: Team, slug: string, id?: string) {
  return `/teams/${team}/${slug}${id === undefined ? "" : `/${id}`}`;
}

function teamRequest(
  team: Team,
  resource: Resource,
  slug: string,
  operation: Operation,
  athlete: Athlete,
  id: string,
): Request {
  if (operation === "L") {
    return { path: teamPath(team, slug) };
  }
  if (operation === "S") {
    return { method: "POST", path: teamPath(team, slug), body: issueFields(team, athlete) };
  }
  if (operation === "W") {
    const body =
      resource === "TrialVideo"
        ? {
            id,
            teamId: team,
            athleteId: resourceId("AthleteProfile", team, athlete),
            title: "Updated",
          }
        : { id, teamId: team, name: "Updated" };
    return { method: "PUT", path: teamPath(team, slug, id), body };
  }
  return { path: teamPath(team, slug, id) };
}

async function issued(response: Response) {
  assert.equal(response.status, 201);
  const { shareLinkId, token } = (await response.json()) as { shareLinkId: string; token: string };
  const claims = verifyShareToken(token, key);
  assert.ok(claims);
  assert.equal(claims.shareLinkId, shareLinkId);
  return { shareLinkId, token, claims };
}

function seeded() {
  const state = fixtureState();
  const store = new MemoryStateStore(state);
  const policy = new AccessPolicy(store, key, () => issuedAt);
  for (const team of teams) {
    store.update((draft) => {
      draft.memberships.push({
        userId: `seed-${team}`,
        teamId: team,
        role: "OrgAdmin",
        active: true,
      });
    });
    for (const athlete of ["self", "other"] as const) {
      assert.ok(policy.issue(`seed-${team}`, team, issueFields(team, athlete)));
    }
  }
  const initial = store.read();
  return { initial, store };
}

test("A1 enumerates the authenticated permission matrix and tenant boundaries over HTTP", async () => {
  const { initial, store } = seeded();
  let count = 0;
  await serve(
    store,
    () => issuedAt,
    async (request) => {
      for (const principal of principals) {
        for (const [index, [resource, slug]] of resources.entries()) {
          for (const operation of operations) {
            for (const team of teams) {
              for (const athlete of ["self", "other"] as const) {
                for (const active of [false, true]) {
                  const links = initial.links.filter((link) => link.teamId === team);
                  const id =
                    resource === "ShareLink"
                      ? links[athlete === "self" ? 0 : 1]?.id
                      : resourceId(resource, team, athlete);
                  assert.ok(id);
                  const user = active ? principal : `${principal}-inactive`;
                  const allowed =
                    active &&
                    team === "a" &&
                    matrix[principal][index]?.includes(operation) === true &&
                    !(
                      athlete === "other" &&
                      (principal === "Guardian" ||
                        (principal === "Athlete" && resource !== "Team" && operation !== "L"))
                    );
                  const input = teamRequest(team, resource, slug, operation, athlete, id);
                  await check(
                    "A1",
                    {
                      principal,
                      resource,
                      operation,
                      team,
                      athlete,
                      active,
                      allowed,
                      path: input.path,
                    },
                    async () => {
                      const response = await request({ ...input, user });
                      if (!allowed) {
                        await assertDenied(response, store, initial);
                      } else if (operation === "S") {
                        const result = await issued(response);
                        assert.equal(store.read().links.length, initial.links.length + 1);
                        assert.equal(
                          result.claims.analysisRevisionId,
                          issueFields(team, athlete).analysisRevisionId,
                        );
                      } else {
                        assert.equal(response.status, 200);
                        const result = (await response.json()) as {
                          id?: string;
                          name?: string;
                          title?: string;
                          count?: number;
                          rows?: { id: string }[];
                        };
                        if (operation === "L") {
                          const ids =
                            resource === "Team"
                              ? [team]
                              : resource === "ShareLink"
                                ? links.map((link) => link.id)
                                : (principal === "Athlete"
                                    ? (["self"] as const)
                                    : (["self", "other"] as const)
                                  ).map((target) => resourceId(resource, team, target));
                          assert.deepEqual(
                            result.rows?.map((row) => row.id),
                            ids,
                          );
                          assert.equal(result.count, ids.length);
                        } else {
                          assert.equal(result.id, id);
                        }
                        if (operation === "R" || operation === "L") {
                          assert.deepEqual(store.read(), initial);
                        } else if (operation === "W") {
                          const expected = structuredClone(initial);
                          const candidates =
                            resource === "Team"
                              ? expected.teams
                              : resource === "AthleteProfile"
                                ? expected.athletes
                                : expected.trials;
                          const row = candidates.find((row) => row.id === id);
                          assert.ok(row);
                          if ("title" in row) {
                            assert.equal(result.title, "Updated");
                            row.title = "Updated";
                          } else {
                            assert.equal(result.name, "Updated");
                            row.name = "Updated";
                          }
                          assert.deepEqual(store.read(), expected);
                        }
                      }
                      count++;
                    },
                  );
                  if (allowed && (operation === "W" || operation === "S")) {
                    store.update((state) => Object.assign(state, structuredClone(initial)));
                  }
                  if (operation === "S" && resource === "ShareLink") {
                    await check(
                      "A1",
                      { principal, resource, operation: "revoke", team, athlete, active, allowed },
                      async () => {
                        const response = await request({
                          method: "DELETE",
                          path: teamPath(team, slug, id),
                          user,
                        });
                        if (allowed) {
                          assert.equal(response.status, 200);
                          assert.deepEqual(await response.json(), { revoked: true });
                          assert.equal(
                            store.read().links.find((link) => link.id === id)?.revoked,
                            true,
                          );
                          store.update((state) => Object.assign(state, structuredClone(initial)));
                        } else {
                          await assertDenied(response, store, initial);
                        }
                        count++;
                      },
                    );
                  }
                }
              }
            }
          }
        }
      }
    },
  );
  assert.equal(
    count,
    principals.length * (resources.length * operations.length + 1) * teams.length * 2 * 2,
  );
  console.log(`A1 permission matrix: ${count} HTTP combinations`);
});

test("A1 rejects conflicting path, query, body and persisted parent/child tenant scopes", async () => {
  const { initial, store } = seeded();
  const baseline = structuredClone(initial);
  for (const foreign of ["b", "c"] as const) {
    const analysis = baseline.analyses.find(
      (row) => row.id === resourceId("AnalysisRevision", "a", "other"),
    );
    const evidence = baseline.evidence.find(
      (row) => row.id === resourceId("EvidenceSnapshot", "a", "other"),
    );
    assert.ok(analysis && evidence);
    baseline.analyses.push({
      ...analysis,
      id: `bad-analysis-${foreign}`,
      trialId: resourceId("TrialVideo", foreign, "other"),
    });
    baseline.evidence.push({
      ...evidence,
      id: `bad-evidence-${foreign}`,
      analysisRevisionId: resourceId("AnalysisRevision", foreign, "other"),
    });
    baseline.trials.push({
      id: `bad-trial-${foreign}`,
      teamId: "a",
      athleteId: resourceId("AthleteProfile", foreign, "other"),
      title: "foreign parent",
    });
  }
  store.update((state) => Object.assign(state, baseline));
  let count = 0;
  await serve(
    store,
    () => issuedAt,
    async (request) => {
      for (const foreign of ["b", "c"] as const) {
        const link = baseline.links.find((row) => row.teamId === foreign);
        assert.ok(link);
        for (const user of ["OrgAdmin", "Coach", "Athlete", "Guardian"]) {
          const targets: [string, Request][] = [
            ["foreign-list-query", { path: `/teams/a/trial-videos?teamId=${foreign}` }],
            ["repeated-team-query", { path: `/teams/a/trial-videos?teamId=a&teamId=${foreign}` }],
            [
              "foreign-owner-query",
              {
                path: `/teams/a/trial-videos?athleteId=${resourceId("AthleteProfile", foreign, "self")}`,
              },
            ],
            [
              "foreign-child-path",
              { path: teamPath("a", "trial-videos", resourceId("TrialVideo", foreign, "self")) },
            ],
            [
              "foreign-child-query",
              {
                path: `${teamPath("a", "trial-videos", resourceId("TrialVideo", "a", "self"))}?id=${resourceId("TrialVideo", foreign, "self")}`,
              },
            ],
            [
              "foreign-team-body",
              {
                method: "PUT",
                path: teamPath("a", "trial-videos", "new"),
                body: {
                  teamId: foreign,
                  athleteId: resourceId("AthleteProfile", "a", "self"),
                  title: "No",
                },
              },
            ],
            [
              "foreign-parent-body",
              {
                method: "PUT",
                path: teamPath("a", "trial-videos", "new"),
                body: {
                  teamId: "a",
                  athleteId: resourceId("AthleteProfile", foreign, "self"),
                  title: "No",
                },
              },
            ],
            [
              "foreign-existing-write",
              teamRequest(
                "a",
                "TrialVideo",
                "trial-videos",
                "W",
                "self",
                resourceId("TrialVideo", foreign, "self"),
              ),
            ],
            [
              "foreign-trial-parent",
              { path: teamPath("a", "analysis-revisions", `bad-analysis-${foreign}`) },
            ],
            [
              "foreign-analysis-parent",
              { path: teamPath("a", "evidence-snapshots", `bad-evidence-${foreign}`) },
            ],
            [
              "foreign-athlete-parent",
              { path: teamPath("a", "trial-videos", `bad-trial-${foreign}`) },
            ],
            [
              "foreign-share-analysis",
              {
                method: "POST",
                path: teamPath("a", "share-links"),
                body: {
                  ...issueFields("a", "self"),
                  analysisRevisionId: resourceId("AnalysisRevision", foreign, "self"),
                },
              },
            ],
            [
              "foreign-share-evidence",
              {
                method: "POST",
                path: teamPath("a", "share-links"),
                body: {
                  ...issueFields("a", "self"),
                  evidenceSnapshotId: resourceId("EvidenceSnapshot", foreign, "self"),
                },
              },
            ],
            [
              "foreign-share-body",
              {
                method: "POST",
                path: teamPath("a", "share-links"),
                body: issueFields(foreign, "self"),
              },
            ],
            [
              "foreign-revocation",
              { method: "DELETE", path: teamPath("a", "share-links", link.id) },
            ],
            [
              "cross-team-guardian-link",
              { path: teamPath("a", "trial-videos", resourceId("TrialVideo", "a", "other")) },
            ],
          ];
          for (const [condition, input] of targets) {
            if (condition === "cross-team-guardian-link" && user !== "Guardian") {
              continue;
            }
            await check("A1", { condition, foreign, principal: user, ...input }, async () => {
              await assertDenied(await request({ ...input, user }), store, baseline);
            });
            count++;
          }
        }
      }
      for (const [resource, slug] of resources.slice(2, 5)) {
        await check(
          "A1",
          { principal: "OrgAdmin", resource, operation: "L", condition: "persisted parent scope" },
          async () => {
            const response = await request({ path: teamPath("a", slug), user: "OrgAdmin" });
            const result = (await response.json()) as { count: number; rows: { id: string }[] };
            assert.equal(response.status, 200);
            assert.equal(result.count, 2);
            assert.deepEqual(
              result.rows.map((row) => row.id),
              [resourceId(resource, "a", "self"), resourceId(resource, "a", "other")],
            );
            assert.deepEqual(store.read(), baseline);
          },
        );
      }
    },
  );
  assert.equal(count, 122);
  console.log(`A1 tenant conflicts: ${count + 3} HTTP cases`);
});

function sharePath(id: string, token?: string, endpoint = "", extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ ...extra, ...(token !== undefined && { token }) });
  return `/shares/${id}${endpoint}?${query}`;
}

test("A2 enumerates token, exact pinned IDs, time, revocation, resources and operations over HTTP", async () => {
  const { initial, store } = seeded();
  const link = initial.links[0];
  const other = initial.links[1];
  assert.ok(link && other);
  const { claims } = link;
  const valid = signShareToken(claims, key);
  const tokens = [
    ["valid", valid],
    ["missing", undefined],
    ["malformed", "missing-separator"],
    ["tampered", valid.replace(/^[A-Za-z]/u, (char) => (char === "A" ? "B" : "A"))],
    ["wrong-secret", signShareToken(claims, wrongKey)],
    ["signed-wrong-link", signShareToken({ ...claims, shareLinkId: other.id }, key)],
    ["signed-wrong-team", signShareToken({ ...claims, teamId: "b" }, key)],
    [
      "signed-wrong-analysis",
      signShareToken({ ...claims, analysisRevisionId: other.claims.analysisRevisionId }, key),
    ],
    [
      "signed-wrong-evidence",
      signShareToken({ ...claims, evidenceSnapshotId: other.claims.evidenceSnapshotId }, key),
    ],
    ["signed-wrong-expiry", signShareToken({ ...claims, expiresAt: expiresAt + 10 }, key)],
  ] as const;
  const targets = [
    { resource: "snapshot", endpoint: "" },
    ...resources.map(([resource, slug]) => ({
      resource,
      endpoint: `/${slug}/${resource === "ShareLink" ? link.id : resourceId(resource, "a", "self")}`,
    })),
  ];
  let now = expiresAt - 1;
  let count = 0;
  await serve(
    store,
    () => now,
    async (request) => {
      for (const offset of [-1, 0, 1]) {
        now = expiresAt + offset;
        for (const revoked of [false, true]) {
          store.update((state) => {
            const row = state.links[0];
            assert.ok(row);
            row.revoked = revoked;
          });
          const baseline = store.read();
          for (const [tokenType, token] of tokens) {
            for (const { resource, endpoint } of targets) {
              for (const operation of operations) {
                const path = sharePath(
                  link.id,
                  token,
                  operation === "L"
                    ? `/${endpoint.split("/")[1] ?? "analysis-revisions"}`
                    : endpoint,
                );
                const method = operation === "W" ? "PUT" : operation === "S" ? "POST" : "GET";
                const allowed =
                  operation === "R" &&
                  ["snapshot", "AnalysisRevision", "EvidenceSnapshot"].includes(resource) &&
                  tokenType === "valid" &&
                  offset === -1 &&
                  !revoked;
                await check(
                  "A2",
                  {
                    principal: "AnonymousShareViewer",
                    resource,
                    operation,
                    tokenType,
                    now,
                    offset,
                    revoked,
                    allowed,
                    path: path.split("?")[0],
                  },
                  async () => {
                    const response = await request({
                      path,
                      method,
                      ...(method !== "GET" && { body: {} }),
                    });
                    if (allowed) {
                      assert.equal(response.status, 200);
                      assert.equal(await response.text(), link.snapshotJson);
                      assert.equal(response.headers.get("cache-control"), "private, no-store");
                      assert.deepEqual(store.read(), baseline);
                    } else {
                      await assertDenied(response, store, baseline);
                    }
                    count++;
                  },
                );
              }
            }
          }
        }
      }
    },
  );
  assert.equal(count, 3 * 2 * tokens.length * targets.length * operations.length);

  await serve(
    store,
    () => issuedAt,
    async (request) => {
      store.update((state) => Object.assign(state, structuredClone(initial)));
      const idChecks = [
        ["link-path", sharePath(other.id, valid)],
        ["team-selector", sharePath(link.id, valid, "", { teamId: "b" })],
        [
          "analysis-selector",
          sharePath(link.id, valid, "", { analysisRevisionId: other.claims.analysisRevisionId }),
        ],
        [
          "evidence-selector",
          sharePath(link.id, valid, "", { evidenceSnapshotId: other.claims.evidenceSnapshotId }),
        ],
        [
          "analysis-path",
          sharePath(link.id, valid, `/analysis-revisions/${other.claims.analysisRevisionId}`),
        ],
        [
          "evidence-path",
          sharePath(link.id, valid, `/evidence-snapshots/${other.claims.evidenceSnapshotId}`),
        ],
        [
          "path-and-query",
          sharePath(link.id, valid, `/analysis-revisions/${claims.analysisRevisionId}`, {
            analysisRevisionId: other.claims.analysisRevisionId,
          }),
        ],
        [
          "analysis-direct",
          `${teamPath("a", "analysis-revisions", claims.analysisRevisionId)}?token=${valid}`,
        ],
        [
          "video-direct",
          `${teamPath("a", "trial-videos", resourceId("TrialVideo", "a", "self"))}?token=${valid}`,
        ],
        ["roster-direct", `${teamPath("a", "athlete-profiles")}?token=${valid}`],
      ] as const;
      for (const [condition, path] of idChecks) {
        await check(
          "A2",
          { principal: "AnonymousShareViewer", operation: "R", condition, tokenType: "valid" },
          async () => {
            await assertDenied(await request({ path }), store, initial);
          },
        );
      }
      count += idChecks.length;
    },
  );
  console.log(`A2 signed capability matrix: ${count} HTTP combinations`);
}, 60000);

test("A2 rechecks a previously fetched link after expiry or revocation and requires new IDs for re-sharing", async () => {
  for (const transition of ["expiry", "revocation"] as const) {
    await check(
      "A2",
      { principal: "AnonymousShareViewer", resource: "ShareLink", operation: "R", transition },
      async () => {
        const store = new MemoryStateStore(fixtureState());
        let now = issuedAt;
        await serve(
          store,
          () => now,
          async (request) => {
            const input = {
              method: "POST",
              path: teamPath("a", "share-links"),
              user: "Coach",
              body: issueFields("a", "self"),
            };
            const first = await issued(await request(input));
            const path = sharePath(first.shareLinkId, first.token);
            now = expiresAt - 1;
            assert.equal((await request({ path })).status, 200);
            if (transition === "revocation") {
              const response = await request({
                method: "DELETE",
                path: teamPath("a", "share-links", first.shareLinkId),
                user: "Coach",
              });
              assert.equal(response.status, 200);
            } else {
              now = expiresAt;
            }
            const prior = store.read();
            await assertDenied(await request({ path }), store, prior);
            const second = await issued(
              await request({ ...input, body: { ...input.body, expiresAt: expiresAt + 10 } }),
            );
            assert.notEqual(second.shareLinkId, first.shareLinkId);
            assert.equal(
              (await request({ path: sharePath(second.shareLinkId, second.token) })).status,
              200,
            );
            const reissued = store.read();
            await assertDenied(await request({ path }), store, reissued);
          },
        );
      },
    );
  }
});

test("A2 checks an additional access guard on every retrieval", async () => {
  const { initial, store } = seeded();
  const link = initial.links[0];
  assert.ok(link);
  let allowed = true;
  await serve(
    store,
    () => issuedAt,
    async (request) => {
      const path = sharePath(link.id, signShareToken(link.claims, key));
      for (const condition of [true, false]) {
        allowed = condition;
        await check(
          "A2",
          {
            principal: "AnonymousShareViewer",
            resource: "snapshot",
            operation: "R",
            tokenType: "valid",
            guardAllows: condition,
            ...link.claims,
          },
          async () => {
            const response = await request({ path });
            if (condition) {
              assert.equal(response.status, 200);
              assert.equal(await response.text(), link.snapshotJson);
            } else {
              await assertDenied(response, store, initial);
            }
          },
        );
      }
    },
    (claims) => allowed && claims.shareLinkId === link.id,
  );
});

test("A3 pins share bytes and browser rendering across re-analysis, registry updates and contract MINOR migration", async () => {
  const store = new MemoryStateStore(fixtureState());
  const snapshots: unknown[] = [];
  const invalid: unknown[] = [];
  await serve(
    store,
    () => issuedAt,
    async (request) => {
      const engine = new LifecycleEngine(
        { uploadDeadlineTicks: 2, queueDeadlineTicks: 2, execDeadlineTicks: 2, maxAttempts: 2 },
        { calibrationId: "none", pipelineVersion: "1.0.0", modelHash: "none", filterSpec: {} },
      );
      const trial = engine.submitCapture({
        teamId: "a",
        captureId: "share-test",
        contractVersion: "1.0.0",
        video: Uint8Array.of(1),
      });
      const firstJob = engine.snapshot().jobs[0];
      assert.ok(firstJob);
      engine.claim(firstJob.id);
      const firstAnalysis = engine.complete(firstJob.id, 1, { angleDegrees: 18 }, Uint8Array.of(1));
      assert.ok(firstAnalysis);
      const original = issueFields("a", "self");
      store.update((state) => {
        const analysis = state.analyses.find((row) => row.id === original.analysisRevisionId);
        const evidence = state.evidence.find((row) => row.id === original.evidenceSnapshotId);
        assert.ok(analysis && evidence);
        analysis.id = firstAnalysis.id;
        analysis.summary.analysis_revision_id = firstAnalysis.id;
        evidence.analysisRevisionId = firstAnalysis.id;
        original.analysisRevisionId = firstAnalysis.id;
      });
      const input = {
        method: "POST",
        path: teamPath("a", "share-links"),
        user: "Coach",
        body: original,
      };
      const share = await check(
        "A3",
        {
          principal: "Coach",
          operation: "S",
          resource: "ShareLink",
          phase: "baseline",
          ...original,
        },
        () => request(input).then(issued),
      );
      const path = sharePath(share.shareLinkId, share.token);
      let baseline = "";
      const fetchSnapshot = async (phase: string) =>
        check(
          "A3",
          {
            principal: "AnonymousShareViewer",
            operation: "R",
            resource: "snapshot",
            phase,
            ...share.claims,
          },
          async () => {
            const response = await request({ path });
            assert.equal(response.status, 200);
            const json = await response.text();
            baseline ||= json;
            assert.equal(json, baseline);
            const snapshot: unknown = JSON.parse(json);
            assert.ok(validateContract("share_report", snapshot));
            assert.equal(snapshot.analysis_revision_id, firstAnalysis.id);
            assert.equal(snapshot.evidence_registry_version, fixture.evidence_registry_version);
            assert.deepEqual(snapshot.evidence_comparisons, fixture.evidence_comparisons);
            assert.equal(snapshot.non_diagnostic_flag, true);
            assert.equal(snapshot.disclaimer_text_ja, fixture.disclaimer_text_ja);
            snapshots.push(snapshot);
            return snapshot;
          },
        );
      const first = await fetchSnapshot("baseline");
      const newer = engine.requestAnalysis(trial.trialId, {
        ...firstJob.inputs,
        pipelineVersion: "1.1.0",
      });
      engine.claim(newer.id);
      const newerAnalysis = engine.complete(newer.id, 1, { angleDegrees: 22 });
      assert.ok(newerAnalysis && newerAnalysis.id !== firstAnalysis.id);
      assert.equal(engine.currentAnalysis(trial.trialId)?.id, newerAnalysis.id);
      store.update((state) => {
        const analysis = state.analyses.find((row) => row.id === firstAnalysis.id);
        assert.ok(analysis);
        state.analyses.push({
          ...analysis,
          id: newerAnalysis.id,
          summary: {
            ...analysis.summary,
            analysis_revision_id: newerAnalysis.id,
            scalar_metrics: [],
            provenance: {
              ...analysis.summary.provenance,
              pipeline_version: newerAnalysis.inputs.pipelineVersion,
            },
          },
        });
      });
      await fetchSnapshot("new analysis");
      const newEvidence = store.update((state) => {
        const evidence = state.evidence.find((row) => row.id === original.evidenceSnapshotId);
        assert.ok(evidence);
        const next = {
          ...evidence,
          id: "new-evidence",
          analysisRevisionId: newerAnalysis.id,
          registryVersion: "1.1.0",
          comparisons: evidence.comparisons.map((comparison) => ({
            ...comparison,
            observed_value: 22,
          })),
          disclaimerTextJa: '新しい注意文 <比較> & "引用"',
        };
        state.evidence.push(next);
        return next;
      });
      await fetchSnapshot("new registry");
      const migrated = readCompatibleContract("share_report", {
        ...first,
        contract_version: "1.1.0",
        minor_optional_field: "optional",
        kinematic_summary: { ...first.kinematic_summary, contract_version: "1.1.0" },
      });
      assert.ok(migrated);
      store.update((state) => {
        const analysis = state.analyses.find((row) => row.id === newerAnalysis.id);
        assert.ok(analysis);
        state.analyses.push({
          ...analysis,
          id: "analysis-minor",
          summary: {
            ...analysis.summary,
            contract_version: migrated.kinematic_summary.contract_version,
            analysis_revision_id: "analysis-minor",
          },
        });
        state.evidence.push({
          ...newEvidence,
          id: "evidence-minor",
          analysisRevisionId: "analysis-minor",
          contractVersion: migrated.contract_version,
        });
      });
      const newShare = await issued(
        await request({
          ...input,
          body: {
            ...original,
            analysisRevisionId: "analysis-minor",
            evidenceSnapshotId: "evidence-minor",
          },
        }),
      );
      const newResponse = await request({ path: sharePath(newShare.shareLinkId, newShare.token) });
      assert.equal(newResponse.status, 200);
      const newSnapshot: unknown = await newResponse.json();
      assert.ok(validateContract("share_report", newSnapshot));
      assert.equal(newSnapshot.contract_version, "1.1.0");
      assert.equal(newSnapshot.evidence_registry_version, "1.1.0");
      assert.equal(newSnapshot.disclaimer_text_ja, newEvidence.disclaimerTextJa);
      await fetchSnapshot("contract MINOR migration");
      snapshots.push(newSnapshot);

      for (const flag of ["missing", "false"] as const) {
        const { non_diagnostic_flag: _removed, ...withoutFlag } = first;
        const report =
          flag === "false" ? { ...withoutFlag, non_diagnostic_flag: false } : withoutFlag;
        invalid.push(report);
        const evidenceId = `flag-${flag}`;
        store.update((state) => {
          const source = state.evidence.find((row) => row.id === original.evidenceSnapshotId);
          assert.ok(source);
          const { nonDiagnostic: _removed, ...withoutFlag } = source;
          const evidence: EvidenceRecord = {
            ...withoutFlag,
            id: evidenceId,
            ...(flag === "false" && { nonDiagnostic: false }),
          };
          state.evidence.push(evidence);
          const row = state.links.find((row) => row.id === share.shareLinkId);
          assert.ok(row);
          row.snapshotJson = JSON.stringify(report);
        });
        const prior = store.read();
        await check(
          "A3",
          { principal: "Coach", resource: "ShareLink", operation: "S", flag },
          async () => {
            await assertDenied(
              await request({ ...input, body: { ...original, evidenceSnapshotId: evidenceId } }),
              store,
              prior,
            );
          },
        );
        await check(
          "A3",
          { principal: "AnonymousShareViewer", resource: "snapshot", operation: "R", flag },
          async () => {
            await assertDenied(await request({ path }), store, prior);
          },
        );
      }

      store.update((state) => {
        const athlete = state.athletes.find(
          (row) => row.id === resourceId("AthleteProfile", "a", "self"),
        );
        assert.ok(athlete);
        athlete.shareConsent = false;
      });
      for (const [guard, body] of [
        ["consent", original],
        [
          "mixed-trials",
          { ...issueFields("a", "other"), evidenceSnapshotId: original.evidenceSnapshotId },
        ],
        ["expiry-at-issue", { ...issueFields("a", "other"), expiresAt: issuedAt }],
      ] as const) {
        await check(
          "A3",
          { principal: "Coach", resource: "ShareLink", operation: "S", guard, ...body },
          async () => {
            const prior = store.read();
            await assertDenied(await request({ ...input, body }), store, prior);
          },
        );
      }
    },
  );
  await check(
    "A3",
    {
      principal: "AnonymousShareViewer",
      resource: "SSR report",
      operation: "R",
      phases: ["baseline", "re-analysis", "registry", "contract MINOR", "new snapshot"],
    },
    async () => {
      const renderer = fileURLToPath(
        new URL("../../../scripts/verify-share-renderer.mjs", import.meta.url),
      );
      const rendered = spawnSync(process.execPath, [renderer], {
        input: JSON.stringify({ valid: snapshots, invalid }),
        encoding: "utf8",
        timeout: 45000,
      });
      assert.equal(rendered.status, 0, rendered.stderr || String(rendered.error));
      const [first, ...rest] = JSON.parse(rendered.stdout) as string[];
      assert.ok(first);
      assert.deepEqual(rest.slice(0, 3), [first, first, first]);
      assert.ok(rest[3]?.includes("&lt;比較&gt; &amp; &quot;引用&quot;"));
    },
  );
  console.log(
    "A3 pinned snapshots: 4 byte-identical HTTP and Chromium SSR reads, plus diagnostic flag and issuance guard rejections",
  );
}, 60000);
