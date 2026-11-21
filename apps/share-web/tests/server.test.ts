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

test("serves the comparison page only for an exact GET with the demo option", async () => {
  const apiBaseUrl = "http://127.0.0.1:1";
  const html = '<main data-non-diagnostic="true">医療診断には使用できません。</main>';
  const regular = await startShareWebServer({ apiBaseUrl });
  try {
    const demo = await startShareWebServer({ apiBaseUrl, demoComparisonHtml: () => html });
    try {
      const page = await fetch(`${baseUrl(demo)}/demo/compare`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe(html);

      const invalid = await fetch(`${baseUrl(regular)}/missing`);
      const publicHeaders = [...invalid.headers].filter(([key]) => key !== "date");
      expect(await invalid.text()).toBe("Not found");
      for (const [server, path, method] of [
        [regular, "/demo/compare", "GET"],
        [demo, "/demo/compare?x=1", "GET"],
        [demo, "/demo/compare/", "GET"],
        [demo, "/demo/compare", "POST"],
      ] as const) {
        const denied = await fetch(`${baseUrl(server)}${path}`, { method });
        const headers = [...denied.headers].filter(([key]) => key !== "date");
        expect(denied.status).toBe(404);
        expect(headers).toEqual(publicHeaders);
        expect(await denied.text()).toBe("Not found");
      }
    } finally {
      const closed = once(demo, "close");
      demo.close();
      await closed;
    }
  } finally {
    const closed = once(regular, "close");
    regular.close();
    await closed;
  }
});

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
