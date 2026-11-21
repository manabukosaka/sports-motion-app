import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AccessPolicy, Resource } from "./access-policy.js";

const resources = new Map<string, Resource>([
  ["teams", "Team"],
  ["athlete-profiles", "AthleteProfile"],
  ["trial-videos", "TrialVideo"],
  ["analysis-revisions", "AnalysisRevision"],
  ["evidence-snapshots", "EvidenceSnapshot"],
  ["share-links", "ShareLink"],
]);

export interface ApiOptions {
  policy: AccessPolicy;
  authenticate: (request: IncomingMessage) => string | undefined | Promise<string | undefined>;
}

function respond(response: ServerResponse, status: number, json: string) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(json);
}

class InvalidRequest extends Error {}

function hasBody(request: IncomingMessage) {
  return (
    Boolean(request.headers["transfer-encoding"]) ||
    (request.headers["content-length"] ?? "0") !== "0"
  );
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new InvalidRequest();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length <= 65536) {
      chunks.push(buffer);
    }
  }
  if (length > 65536) {
    throw new InvalidRequest();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRequest();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequest();
  }
  return value as Record<string, unknown>;
}

function parseTarget(target: string) {
  const separator = target.indexOf("?");
  const path = separator < 0 ? target : target.slice(0, separator);
  if (!path.startsWith("/")) {
    throw new InvalidRequest();
  }
  let segments: string[];
  try {
    segments = path.slice(1).split("/").map(decodeURIComponent);
  } catch {
    throw new InvalidRequest();
  }
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || /[/\\\p{Cc}]/u.test(segment),
    )
  ) {
    throw new InvalidRequest();
  }
  const query = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(
    separator < 0 ? "" : target.slice(separator + 1),
  )) {
    if (query.has(key)) {
      throw new InvalidRequest();
    }
    query.set(key, value);
  }
  return { segments, query };
}

function shareView(
  policy: AccessPolicy,
  method: string | undefined,
  segments: string[],
  query: Map<string, string>,
) {
  const [, id, resource, resourceId] = segments;
  const token = query.get("token");
  if (
    method !== "GET" ||
    !id ||
    !token ||
    !(
      segments.length === 2 ||
      (segments.length === 4 &&
        (resource === "analysis-revisions" || resource === "evidence-snapshots"))
    ) ||
    [...query.keys()].some(
      (key) => !["token", "teamId", "analysisRevisionId", "evidenceSnapshotId"].includes(key),
    )
  ) {
    return;
  }
  const teamId = query.get("teamId");
  const queryAnalysis = query.get("analysisRevisionId");
  const queryEvidence = query.get("evidenceSnapshotId");
  if (
    (resource === "analysis-revisions" &&
      queryAnalysis !== undefined &&
      queryAnalysis !== resourceId) ||
    (resource === "evidence-snapshots" &&
      queryEvidence !== undefined &&
      queryEvidence !== resourceId)
  ) {
    return;
  }
  const analysisRevisionId = resource === "analysis-revisions" ? resourceId : queryAnalysis;
  const evidenceSnapshotId = resource === "evidence-snapshots" ? resourceId : queryEvidence;
  return policy.readShare(id, token, {
    ...(teamId !== undefined && { teamId }),
    ...(analysisRevisionId !== undefined && { analysisRevisionId }),
    ...(evidenceSnapshotId !== undefined && { evidenceSnapshotId }),
  });
}

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiOptions,
) {
  try {
    if ((request.method === "GET" || request.method === "DELETE") && hasBody(request)) {
      return respond(response, 404, '{"error":"not_found"}');
    }
    const { segments, query } = parseTarget(request.url ?? "");
    if (segments[0] === "shares") {
      const json = shareView(options.policy, request.method, segments, query);
      return json === undefined
        ? respond(response, 404, '{"error":"not_found"}')
        : respond(response, 200, json);
    }

    const [route, teamId, collection, id] = segments;
    const resource = collection ? resources.get(collection) : undefined;
    if (
      route !== "teams" ||
      !teamId ||
      !resource ||
      segments.length > 4 ||
      [...query].some(
        ([key, value]) =>
          !((key === "teamId" && value === teamId) || (key === "id" && value === id)),
      )
    ) {
      return respond(response, 404, '{"error":"not_found"}');
    }
    const { policy } = options;
    const userId = await options.authenticate(request);
    let result: unknown;
    let status = 200;
    if (request.method === "GET") {
      result = id
        ? policy.read(userId, teamId, resource, id)
        : policy.list(userId, teamId, resource);
    } else if (request.method === "PUT" && id) {
      result = policy.write(userId, teamId, resource, id, await body(request));
    } else if (request.method === "POST" && resource === "ShareLink" && id === undefined) {
      result = policy.issue(userId, teamId, await body(request));
      status = 201;
    } else if (request.method === "DELETE" && resource === "ShareLink" && id) {
      result = policy.revoke(userId, teamId, id) ? { revoked: true } : undefined;
    }
    return result === undefined
      ? respond(response, 404, '{"error":"not_found"}')
      : respond(response, status, JSON.stringify(result));
  } catch (error) {
    if (response.destroyed) {
      return;
    }
    if (error instanceof InvalidRequest) {
      return respond(response, 404, '{"error":"not_found"}');
    }
    respond(response, 500, '{"error":"internal_error"}');
  }
}

export function createApiServer(options: ApiOptions) {
  return createServer((request, response) => {
    void handleApiRequest(request, response, options);
  });
}
