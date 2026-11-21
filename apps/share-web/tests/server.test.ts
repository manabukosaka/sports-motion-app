import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import { startShareWebServer } from "../src/index.js";

function baseUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a listening HTTP server");
  }
  return `http://127.0.0.1:${address.port}`;
}

test("uses only the signed share capability and rejects invalid upstream reports", async () => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("../../../packages/contracts/fixtures/valid/share_report.json", import.meta.url),
      "utf8",
    ),
  );
  const shareLinkId = "link id";
  const token = "signed&token";
  const path = `/share/${encodeURIComponent(shareLinkId)}`;
  const query = `?token=${encodeURIComponent(token)}`;
  const report = { ...snapshot, share_link_id: shareLinkId };
  const forwarded: Array<{
    url: string | undefined;
    authorization: string | undefined;
    cookie: string | undefined;
  }> = [];
  let upstream = { status: 200, body: JSON.stringify(report) };
  const api = createServer((request, response) => {
    forwarded.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    if (request.url === `${path}/pose3d${query}`) {
      response.writeHead(404).end();
    } else {
      response
        .writeHead(upstream.status, { "Content-Type": "application/json" })
        .end(upstream.body);
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  let web: Server | undefined;
  try {
    web = await startShareWebServer({ apiBaseUrl: baseUrl(api) });
    const url = `${baseUrl(web)}${path}${query}`;
    const response = await fetch(url, {
      headers: { Authorization: "Bearer private", Cookie: "session=private" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("このレポートには3D骨格がありません。");
    expect(forwarded).toEqual([
      { url: `${path}${query}`, authorization: undefined, cookie: undefined },
      { url: `${path}/pose3d${query}`, authorization: undefined, cookie: undefined },
    ]);

    for (const failure of [
      { status: 403, body: "private upstream details" },
      { status: 200, body: "malformed JSON" },
      { status: 200, body: JSON.stringify({ ...report, non_diagnostic_flag: false }) },
      { status: 200, body: JSON.stringify({ ...report, share_link_id: "unrelated" }) },
    ]) {
      upstream = failure;
      const rejected = await fetch(url);
      expect(rejected.status).toBe(404);
      expect(rejected.headers.get("cache-control")).toBe("private, no-store");
      expect(rejected.headers.get("referrer-policy")).toBe("no-referrer");
      expect(rejected.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await rejected.text()).toBe("Not found");
    }
    expect(forwarded).toHaveLength(6);
  } finally {
    await Promise.all(
      [web, api].map(async (server) => {
        if (server) {
          const closed = once(server, "close");
          server.close();
          await closed;
        }
      }),
    );
  }
});
