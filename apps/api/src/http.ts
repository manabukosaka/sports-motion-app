import type { KeyObject } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AccessPolicy, Resource } from "./access-policy.js";
import { AnalysisConflict } from "./analysis.js";
import { isMediaObjectKey, isMediaSegment, signMediaUrl } from "./media-signing.js";
import { InvalidMotionInput, type MotionWorker, UvMotionWorker } from "./worker.js";

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
  mediaSigning?: { baseUrl: string; secret: KeyObject; now?: () => number };
  worker?: MotionWorker;
}

const analysisWorker = new UvMotionWorker();
const metadataBodyLimit = 64 * 1024;
const analysisBodyLimit = 2 * 1024 * 1024;

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
class PayloadTooLarge extends InvalidRequest {}

function hasBody(request: IncomingMessage) {
  return (
    Boolean(request.headers["transfer-encoding"]) ||
    (request.headers["content-length"] ?? "0") !== "0"
  );
}

async function body(
  request: IncomingMessage,
  response: ServerResponse,
  limit = metadataBodyLimit,
): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"]) > limit) {
    throw new PayloadTooLarge();
  }
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new InvalidRequest();
  }
  if (request.headers.expect?.toLowerCase() === "100-continue") {
    response.writeContinue();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > limit) {
      throw new PayloadTooLarge();
    }
    chunks.push(chunk);
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
  const pose = segments[0] === "share" && segments.length === 3 && resource === "pose3d";
  if (
    method !== "GET" ||
    !id ||
    !token ||
    !(
      segments.length === 2 ||
      pose ||
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
  return policy.readShare(
    id,
    token,
    {
      ...(teamId !== undefined && { teamId }),
      ...(analysisRevisionId !== undefined && { analysisRevisionId }),
      ...(evidenceSnapshotId !== undefined && { evidenceSnapshotId }),
    },
    pose ? "pose3d" : "report",
  );
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
    if (segments[0] === "shares" || segments[0] === "share") {
      const json = shareView(options.policy, request.method, segments, query);
      return json === undefined
        ? respond(response, 404, '{"error":"not_found"}')
        : respond(response, 200, json);
    }

    const [route, teamId, collection, id, action] = segments;
    const analyze =
      request.method === "POST" &&
      (collection === "trial-videos" || collection === "trials") &&
      segments.length === 5 &&
      action === "analyze";
    const revise =
      request.method === "POST" &&
      collection === "trials" &&
      segments.length === 5 &&
      action === "revisions";
    const checkpoints =
      request.method === "GET" &&
      collection === "evidence-snapshots" &&
      segments.length === 5 &&
      action === "checkpoints";
    const signedUrl =
      request.method === "POST" &&
      collection === "trial-videos" &&
      action === "signed-url" &&
      segments.length === 5;
    const deleteAthlete =
      request.method === "DELETE" &&
      collection === "athletes" &&
      action === "personal-data" &&
      segments.length === 5;
    const resource =
      analyze || revise
        ? "TrialVideo"
        : deleteAthlete
          ? "AthleteProfile"
          : collection && resources.get(collection);
    if (
      route !== "teams" ||
      !teamId ||
      !resource ||
      (segments.length > 4 &&
        !analyze &&
        !revise &&
        !checkpoints &&
        !signedUrl &&
        !deleteAthlete) ||
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
    if ((analyze || revise) && id) {
      if (!policy.canAnalyzeTrial(userId, teamId, id)) {
        if (hasBody(request)) {
          response.setHeader("Connection", "close");
        }
        return respond(response, 404, '{"error":"not_found"}');
      }
      const input = await body(request, response, analysisBodyLimit);
      const worker = options.worker ?? analysisWorker;
      const analysis = revise
        ? await policy.commitCoordinateRevision(userId, teamId, id, input, worker)
        : await policy.analyzeTrial(userId, teamId, id, input, worker);
      result = analysis?.receipt;
      status = analysis?.created ? 201 : 200;
    } else if (signedUrl && id) {
      const media = options.mediaSigning;
      if (!media || !policy.canAccessTrialVideo(userId, teamId, id, "R")) {
        if (hasBody(request)) {
          response.setHeader("Connection", "close");
        }
        return respond(response, 404, '{"error":"not_found"}');
      }
      const {
        method,
        object_key = "video.mp4",
        ttl_seconds = 300,
        ...extra
      } = await body(request, response);
      if (
        (method === "GET" || method === "PUT") &&
        isMediaSegment(teamId) &&
        isMediaSegment(id) &&
        isMediaObjectKey(object_key) &&
        typeof ttl_seconds === "number" &&
        Number.isSafeInteger(ttl_seconds) &&
        ttl_seconds > 0 &&
        Object.keys(extra).length === 0 &&
        policy.canAccessTrialVideo(userId, teamId, id, method === "GET" ? "R" : "W")
      ) {
        const expiresAt = (media.now ?? Date.now)() + Math.min(ttl_seconds, 900) * 1000;
        const url = signMediaUrl(
          { baseUrl: media.baseUrl, teamId, trialId: id, objectKey: object_key, method, expiresAt },
          media.secret,
        );
        result = { url, expires_at: new Date(expiresAt).toISOString(), method, object_key };
      }
    } else if (deleteAthlete && id) {
      result = policy.deleteAthletePersonalData(userId, teamId, id);
    } else if (checkpoints && id) {
      result = policy.readEvidenceCheckpoints(userId, teamId, id);
    } else if (request.method === "GET") {
      result = id
        ? policy.read(userId, teamId, resource, id)
        : policy.list(userId, teamId, resource);
    } else if (request.method === "PUT" && id) {
      result = policy.write(userId, teamId, resource, id, await body(request, response));
    } else if (request.method === "POST" && resource === "ShareLink" && id === undefined) {
      result = policy.issue(userId, teamId, await body(request, response));
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
    if (error instanceof PayloadTooLarge) {
      request.pause();
      response.setHeader("Connection", "close");
      return respond(response, 413, '{"error":"payload_too_large"}');
    }
    if (error instanceof InvalidRequest) {
      return respond(response, 404, '{"error":"not_found"}');
    }
    if (error instanceof InvalidMotionInput) {
      return respond(response, 422, '{"error":"invalid_analysis_input"}');
    }
    if (error instanceof AnalysisConflict) {
      return respond(response, 409, '{"error":"analysis_conflict"}');
    }
    respond(response, 500, '{"error":"internal_error"}');
  }
}

export function createApiServer(options: ApiOptions) {
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    void handleApiRequest(request, response, options);
  };
  return createServer(handle).on("checkContinue", handle);
}

export async function startApiServer(options: ApiOptions, { host = "127.0.0.1", port = 0 } = {}) {
  const server = createApiServer(options);
  server.listen(port, host);
  await once(server, "listening");
  return server;
}
