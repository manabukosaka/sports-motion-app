import assert from "node:assert/strict";
import { chromium } from "playwright";
import { renderTwoTrialComparisonHtml } from "../apps/share-web/dist/index.js";
import { compareTwoTrials } from "../packages/coaching/dist/packages/coaching/src/index.js";
import {
  asFrameIndex,
  asSeconds,
  CONTRACT_VERSION,
} from "../packages/contracts/dist/packages/contracts/src/index.js";

function makeTrial(revisionId, peakFraction, peakValue, startFrame, endFrame) {
  return {
    contract_version: CONTRACT_VERSION,
    analysis_revision_id: revisionId,
    movement_type: "running",
    provenance: {
      contract_version: CONTRACT_VERSION,
      pipeline_version: "1.0.0",
      stage_models: [{ stage: "filter_and_kinematics", model_hash: "none", license_tier: "A" }],
      filter_spec_version: "1.0.0",
      calibration_id_or_none: "calibration-dlt",
      coordinate_revision_id: `coords-${revisionId}`,
    },
    events: [
      {
        event_id: "run_initial_contact",
        frame_index: asFrameIndex(startFrame),
        timestamp_sec: asSeconds(0.1),
        detection_mode: "manual",
        side: "right",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: asFrameIndex(endFrame),
        timestamp_sec: asSeconds(0.9),
        detection_mode: "manual",
        side: "right",
      },
    ],
    scalar_metrics: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        event_id: "run_initial_contact",
        value_or_null: 18,
        unit: "deg",
        anatomical_plane: "sagittal",
        missing_reason_or_null: null,
        side: "right",
      },
    ],
    normalized_waveforms: [
      {
        metric_id: "run_knee_flexion_extension_angle",
        interval_id: "run_stride",
        unit: "deg",
        anatomical_plane: "sagittal",
        side: "right",
        points: [
          { normalized_time_fraction: 0, value: 18 },
          { normalized_time_fraction: peakFraction, value: peakValue },
          { normalized_time_fraction: 1, value: 16 },
        ],
      },
    ],
  };
}

const comparison = compareTwoTrials({
  baseline: makeTrial("trial-baseline", 0.4, 42, 10, 91),
  target: makeTrial("trial-target", 0.5, 49, 20, 181),
  metricId: "run_knee_flexion_extension_angle",
  intervalId: "run_stride",
  side: "right",
  referenceBand: {
    metric_id: "run_knee_flexion_extension_angle",
    interval_id: "run_stride",
    unit: "deg",
    source: { kind: "synthetic", dataset: "Comparison browser verification" },
    points: [
      { percent_0_to_100: 0, mean: 19, sd: 2 },
      { percent_0_to_100: 50, mean: 44, sd: 5 },
      { percent_0_to_100: 100, mean: 17, sd: 2 },
    ],
  },
});

const xssPayload = `</script><img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`;
const html = renderTwoTrialComparisonHtml({
  comparison,
  baselineLabel: "過去ベスト",
  targetLabel: "最新試技",
  annotations: [
    {
      id: "ann-line",
      kind: "line",
      startFrame: asFrameIndex(10),
      endFrame: asFrameIndex(60),
      points: [
        { x: 0.15, y: 0.25 },
        { x: 0.85, y: 0.75 },
      ],
      colorHex: "#047c6d",
    },
    {
      id: "ann-xss",
      kind: "label",
      startFrame: asFrameIndex(10),
      endFrame: asFrameIndex(90),
      points: [{ x: 0.2, y: 0.5 }],
      colorHex: "#ba4b2b",
      label: xssPayload,
    },
  ],
  comments: [
    {
      id: "cmt-xss",
      kind: "text",
      frameIndex: asFrameIndex(50),
      authorRole: "Coach",
      createdAt: "2026-11-20T10:00:00Z",
      text: xssPayload,
    },
  ],
});

const browser = await chromium.launch();
try {
  const viewport = { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const requests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://comparison.test/view", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );

  await page.goto("https://comparison.test/view", { waitUntil: "domcontentloaded" });

  assert.deepEqual(requests, ["https://comparison.test/view"]);
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute("content"),
    "noindex, nofollow",
  );
  const main = page.locator("main");
  assert.equal(await main.getAttribute("data-non-diagnostic"), "true");

  const disclaimer = page.locator("#disclaimer");
  assert.equal(await disclaimer.isVisible(), true);
  assert.equal(await disclaimer.textContent(), comparison.disclaimer_text_ja);

  assert.match(await page.locator("#baseline-curve").getAttribute("d"), /^M.+L/u);
  assert.match(await page.locator("#target-curve").getAttribute("d"), /^M.+L/u);
  assert.match(await page.locator("#reference-band-path").getAttribute("d"), /^M.+Z$/u);
  assert.match(
    await page.locator("#reference-band-source").textContent(),
    /Comparison browser verification/u,
  );

  const scrubber = page.locator("#compare-scrubber");
  const line = page.locator('[data-annotation-id="ann-line"]');
  assert.equal(await line.getAttribute("visibility"), "visible");
  const samples = await scrubber.evaluate(
    (input, percents) => {
      const a = document.querySelector("#trial-a-indicator");
      const b = document.querySelector("#trial-b-indicator");
      const sync = document.querySelector("#sync-delta-indicator");
      const cursor = document.querySelector("#comparison-cursor");
      return percents.map((percent) => {
        input.value = String(percent);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          percent,
          aPercent: Number(a?.getAttribute("data-percent")),
          bPercent: Number(b?.getAttribute("data-percent")),
          aFrame: Number(a?.getAttribute("data-frame")),
          bFrame: Number(b?.getAttribute("data-frame")),
          aValue: a?.value,
          bValue: b?.value,
          syncDelta: Number(sync?.getAttribute("data-sync-delta")),
          cursorX: Number(cursor?.getAttribute("x1")),
        };
      });
    },
    [0, 25, 50, 75, 100],
  );

  for (const sample of samples) {
    assert.equal(sample.aPercent, sample.percent);
    assert.equal(sample.bPercent, sample.percent);
    const exactA = 10 + (81 * sample.percent) / 100;
    const exactB = 20 + (161 * sample.percent) / 100;
    assert.equal(sample.aFrame, Math.round(exactA));
    assert.equal(sample.bFrame, Math.round(exactB));
    assert.equal(
      sample.syncDelta,
      Math.max(Math.abs(sample.aFrame - exactA), Math.abs(sample.bFrame - exactB)),
    );
  }
  assert.equal(samples[1]?.aValue, "25% (F30 · 33.0 deg)");
  assert.equal(samples[1]?.bValue, "25% (F60 · 33.5 deg)");
  assert.ok(new Set(samples.map(({ cursorX }) => cursorX)).size === samples.length);
  assert.equal(await line.getAttribute("visibility"), "hidden");

  await page.locator('button.rate-btn[data-rate="0.25"]').click();
  assert.equal(await main.getAttribute("data-rate"), "0.25");
  assert.equal(await page.locator("#playback-controls").getAttribute("data-rate"), "0.25");
  assert.equal(
    await page.locator('button.rate-btn[data-rate="0.25"]').getAttribute("aria-pressed"),
    "true",
  );
  const toggle = page.locator("#comparison-playback-toggle");
  await toggle.click();
  await page.clock.runFor(400);
  const slowPlaybackPercent = Number(await scrubber.inputValue());
  assert.ok(slowPlaybackPercent >= 12 && slowPlaybackPercent <= 13);
  await toggle.click();
  await page.clock.runFor(400);
  assert.equal(Number(await scrubber.inputValue()), slowPlaybackPercent);
  await page.locator('button.rate-btn[data-rate="1"]').click();
  await toggle.click();
  await page.clock.runFor(800);
  assert.equal(Number(await scrubber.inputValue()), 100);
  assert.equal(await toggle.textContent(), "再生");

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requests, ["https://comparison.test/view"]);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(
    await page.locator('[data-comment-id="cmt-xss"]').textContent(),
    `Coach (F50): ${xssPayload}`,
  );

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        browser: `Chromium ${browser.version()}`,
        viewport,
        is_mobile: true,
        max_sync_delta: Math.max(...samples.map(({ syncDelta }) => syncDelta)),
        slow_playback_percent: slowPlaybackPercent,
        final_playback_percent: Number(await scrubber.inputValue()),
        selected_rate: await main.getAttribute("data-rate"),
        external_requests: requests.length - 1,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
