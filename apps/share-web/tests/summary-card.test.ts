import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { expect, test } from "vitest";
import { renderShareSummaryCardSvg, startShareWebServer } from "../src/index.js";

function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../../../packages/contracts/fixtures/valid/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

test("renders a deterministic 1200 × 630 card with frozen metrics, evidence and disclaimer", () => {
  const snapshot = fixture("share_report.synthetic_comparison");
  const svg = renderShareSummaryCardSvg(snapshot);
  expect(svg).toBe(renderShareSummaryCardSvg(snapshot));
  expect(svg).toMatch(
    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630" viewBox="0 0 1200 630"[\s\S]+<\/svg>$/u,
  );
  for (const text of [
    "動作分析レポート",
    "ランニング",
    "analysis-running-dlt",
    "0.0.0-fixture",
    "18 deg",
    "平均 20 ± 4",
    "10.0000/synthetic-contract-fixture",
    snapshot.disclaimer_text_ja,
  ]) {
    expect(svg).toContain(text);
  }
  expect(renderShareSummaryCardSvg(fixture("share_report"))).toContain("参照文献データ未登録");
});

test("escapes injected XML and replaces characters that XML 1.0 cannot represent", () => {
  const snapshot = fixture("share_report");
  const payload = `</text><script>alert("'&")</script>\u0000`;
  snapshot.analysis_revision_id = payload;
  snapshot.kinematic_summary.analysis_revision_id = payload;
  snapshot.disclaimer_text_ja = payload;
  const svg = renderShareSummaryCardSvg(snapshot);
  expect(svg).toContain(
    "&lt;/text&gt;&lt;script&gt;alert(&quot;&apos;&amp;&quot;)&lt;/script&gt;\uFFFD",
  );
  expect(svg).not.toContain(payload);
  expect(svg).not.toContain("<script>");
  expect(svg).not.toContain("\u0000");
});

test("rejects malformed and diagnostic snapshots", () => {
  expect(() => renderShareSummaryCardSvg({})).toThrow(TypeError);
  expect(() =>
    renderShareSummaryCardSvg({ ...fixture("share_report"), non_diagnostic_flag: false }),
  ).toThrow(TypeError);
});

function baseUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a listening HTTP server");
  }
  return `http://127.0.0.1:${address.port}`;
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

test("serves the pinned SVG only through the signed capability and links to it safely", async () => {
  const snapshot = { ...fixture("share_report"), share_link_id: "link <id>" };
  const path = `/share/${encodeURIComponent(snapshot.share_link_id)}`;
  const token = 'signed&"token';
  const query = `?token=${encodeURIComponent(token)}`;
  const cardPath = `${path}/card.svg`;
  const forwarded: Array<string | undefined> = [];
  let report: unknown = snapshot;
  let revoked = false;
  const api = createServer((request, response) => {
    forwarded.push(request.url);
    if (request.url === `${path}${query}` && !revoked) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    } else {
      response.writeHead(404).end("private upstream details");
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  let web: Server | undefined;
  try {
    web = await startShareWebServer({ apiBaseUrl: baseUrl(api) });
    const url = baseUrl(web);
    const response = await fetch(`${url}${cardPath}${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expectPrivateHeaders(response);
    expect(await response.text()).toBe(renderShareSummaryCardSvg(snapshot));
    expect(forwarded).toEqual([`${path}${query}`]);

    const page = await fetch(`${url}${path}${query}`);
    expect(page.status).toBe(200);
    expectPrivateHeaders(page);
    expect(await page.text()).toContain(`href="${cardPath}${query}" rel="noreferrer"`);
    expect(forwarded.at(-1)).toBe(`${path}/pose3d${query}`);

    const expectNotFound = async (requestPath: string) => {
      const response = await fetch(`${url}${requestPath}`);
      expect(response.status).toBe(404);
      expectPrivateHeaders(response);
      expect(await response.text()).toBe("Not found");
    };
    await expectNotFound(`${cardPath}?token=tampered`);
    await expectNotFound(`${cardPath}?token=expired`);
    await expectNotFound(cardPath);
    await expectNotFound(`${cardPath}${query}&token=duplicate`);
    report = { ...snapshot, share_link_id: "different" };
    await expectNotFound(`${cardPath}${query}`);
    report = { ...snapshot, non_diagnostic_flag: false };
    await expectNotFound(`${cardPath}${query}`);
    report = snapshot;
    revoked = true;
    await expectNotFound(`${cardPath}${query}`);
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
