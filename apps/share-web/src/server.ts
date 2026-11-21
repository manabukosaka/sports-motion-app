import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { validateContract } from "@sports-motion/contracts";
import { renderInteractiveSharePageHtml } from "./interactive.js";

interface ShareWebOptions {
  apiBaseUrl: string;
  host?: string;
  port?: number;
}

async function sharePage(request: IncomingMessage, apiBaseUrl: string) {
  const separator = request.url?.indexOf("?") ?? -1;
  if (request.method !== "GET" || !request.url || separator < 0) {
    return;
  }
  const match = /^\/share\/([^/]+)$/u.exec(request.url.slice(0, separator));
  if (!match?.[1]) {
    return;
  }
  const shareLinkId = decodeURIComponent(match[1]);
  if (
    !shareLinkId ||
    shareLinkId === "." ||
    shareLinkId === ".." ||
    /[/\\\p{Cc}]/u.test(shareLinkId)
  ) {
    return;
  }
  const params = Array.from(new URLSearchParams(request.url.slice(separator + 1)));
  const [key, token] = params[0] ?? [];
  if (params.length !== 1 || key !== "token" || !token) {
    return;
  }
  const target = `${apiBaseUrl}/share/${encodeURIComponent(shareLinkId)}`;
  const signedQuery = `?token=${encodeURIComponent(token)}`;
  const options = { redirect: "error", signal: AbortSignal.timeout(2500) } as const;
  const reportResponse = await fetch(`${target}${signedQuery}`, options);
  if (reportResponse.status !== 200) {
    await reportResponse.body?.cancel();
    return;
  }
  const snapshot: unknown = await reportResponse.json();
  if (
    !validateContract("share_report", snapshot) ||
    snapshot.non_diagnostic_flag !== true ||
    snapshot.share_link_id !== shareLinkId
  ) {
    return;
  }
  const poseResponse = await fetch(`${target}/pose3d${signedQuery}`, options);
  if (poseResponse.status !== 200) {
    await poseResponse.body?.cancel();
    return poseResponse.status === 404 ? renderInteractiveSharePageHtml(snapshot) : undefined;
  }
  const pose: unknown = await poseResponse.json();
  if (!validateContract("pose3d", pose) || pose.contract_version !== snapshot.contract_version) {
    return;
  }
  return renderInteractiveSharePageHtml(snapshot, pose);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiBaseUrl: string,
) {
  let html: string | undefined;
  try {
    html = await sharePage(request, apiBaseUrl);
  } catch {
    // Route and upstream failures have the same public response.
  }
  response.writeHead(html === undefined ? 404 : 200, {
    "Content-Type": html === undefined ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html ?? "Not found");
}

export async function startShareWebServer({
  apiBaseUrl,
  host = "127.0.0.1",
  port = 0,
}: ShareWebOptions) {
  const baseUrl = apiBaseUrl.replace(/\/+$/u, "");
  const server = createServer((request, response) => {
    void handleRequest(request, response, baseUrl);
  });
  server.listen(port, host);
  await once(server, "listening");
  return server;
}
