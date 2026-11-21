import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { renderShareReportHtml } from "../apps/share-web/dist/index.js";

const { valid, invalid } = JSON.parse(readFileSync(0, "utf8"));
for (const report of invalid) {
  assert.throws(() => renderShareReportHtml(report), TypeError);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  let markup;
  await page.route("https://share.test/report", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: markup }),
  );
  const rendered = [];
  for (const snapshot of valid) {
    markup = renderShareReportHtml(snapshot);
    await page.goto("https://share.test/report");
    const main = page.locator("main");
    const disclaimer = page.locator("#disclaimer");
    assert.equal(
      await main.getAttribute("data-analysis-revision-id"),
      snapshot.analysis_revision_id,
    );
    assert.equal(
      await main.getAttribute("data-evidence-registry-version"),
      snapshot.evidence_registry_version,
    );
    assert.equal(await main.getAttribute("data-non-diagnostic"), "true");
    assert.equal(await disclaimer.isVisible(), true);
    assert.equal(await disclaimer.textContent(), snapshot.disclaimer_text_ja);
    assert.equal(
      await page.locator('meta[property="og:description"]').getAttribute("content"),
      snapshot.disclaimer_text_ja,
    );
    assert.equal(await page.locator('meta[property="og:title"]').count(), 1);
    rendered.push(markup);
  }
  process.stdout.write(JSON.stringify(rendered));
} finally {
  await browser.close();
}
