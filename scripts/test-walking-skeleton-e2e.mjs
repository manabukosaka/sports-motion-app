import assert from "node:assert/strict";
import { createSecretKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  AccessPolicy,
  MemoryStateStore,
  startApiServer,
  UvMotionWorker,
} from "../apps/api/dist/index.js";
import { createLocalCapture, WalkingSkeletonMobileClient } from "../apps/mobile/dist/index.js";
import { startShareWebServer } from "../apps/share-web/dist/index.js";

const teamId = "e2e-team";
const trialId = "e2e-trial";
const athleteId = "e2e-athlete";
const coachId = "e2e-coach";
const viewport = { width: 390, height: 844 };
const fps = 60;

function calibratedCapture() {
  const calibration = JSON.parse(
    readFileSync(
      new URL("../packages/contracts/fixtures/valid/calibration.dlt.json", import.meta.url),
      "utf8",
    ),
  );
  calibration.contract_version = "1.0.0";
  const markersMeters = [
    ["right_hip", 0, 1, 0, 0],
    ["right_knee_left_epicondyle", -0.04, 0.6, 0, 0.05],
    ["right_knee_right_epicondyle", 0.04, 0.6, 0, 0.05],
    ["right_ankle_left_malleolus", -0.03, 0.2, 0.16, 0.15],
    ["right_ankle_right_malleolus", 0.03, 0.2, 0.16, 0.15],
  ];
  const views = calibration.views.map(({ view_id, dlt_params: p }) => ({
    contract_version: "1.0.0",
    trial_id: trialId,
    view_id,
    fps,
    width_px: 1920,
    height_px: 1080,
    lens_undistorted: true,
    coordinate_frame: "Image2D",
    unit: "px",
    frames: Array.from({ length: 80 }, (_, frame_index) => ({
      frame_index,
      timestamp_sec: frame_index / fps,
      landmarks: markersMeters.map(([landmark_id, xMeters, yMeters, zMeters, amplitudeMeters]) => {
        const phase = Math.sin(frame_index / 10);
        const x = xMeters + 0.02 * phase;
        const z = zMeters + amplitudeMeters * phase;
        const denominator = p[8] * x + p[9] * yMeters + p[10] * z + 1;
        return {
          landmark_id,
          x: (p[0] * x + p[1] * yMeters + p[2] * z + p[3]) / denominator,
          y: (p[4] * x + p[5] * yMeters + p[6] * z + p[7]) / denominator,
          confidence: 1,
          source: "tracker_raw",
          missing_reason: null,
        };
      }),
    })),
  }));
  return createLocalCapture({
    capture_id: "e2e-capture",
    views,
    calibration,
    movement: "running",
    events: [
      {
        event_id: "run_initial_contact",
        frame_index: 8,
        timestamp_sec: 8 / fps,
        detection_mode: "manual",
      },
      {
        event_id: "run_next_initial_contact",
        frame_index: 62,
        timestamp_sec: 62 / fps,
        detection_mode: "manual",
      },
    ],
  });
}

function baseUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function verifyViewer(browser, shareUrl, invalidToken, analysis) {
  const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const started = performance.now();
  const response = await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 3000 });
  assert.equal(response?.status(), 200);
  const canvas = page.locator("#skeleton-canvas");
  await page.locator("#skeleton-canvas[data-frame]").waitFor({ timeout: 3000 });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  const loadMs = performance.now() - started;
  assert.ok(loadMs < 3000, `Initial report paint took ${loadMs.toFixed(1)} ms`);
  assert.equal(response.headers()["cache-control"], "private, no-store");
  assert.equal(response.headers()["referrer-policy"], "no-referrer");
  assert.equal(response.headers()["x-content-type-options"], "nosniff");
  assert.equal(await page.locator('meta[property="og:type"]').getAttribute("content"), "website");
  assert.equal(
    await page.locator('meta[property="og:title"]').getAttribute("content"),
    "動作分析レポート",
  );
  assert.equal(
    await page.locator('meta[property="og:description"]').getAttribute("content"),
    analysis.disclaimer_text_ja,
  );
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute("content"),
    "noindex, nofollow",
  );
  assert.equal(await page.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
  const report = page.locator("main");
  assert.equal(await report.getAttribute("data-non-diagnostic"), "true");
  assert.equal(
    await report.getAttribute("data-analysis-revision-id"),
    analysis.analysis_revision_id,
  );
  assert.equal(
    await report.getAttribute("data-evidence-registry-version"),
    analysis.evidence_registry_version,
  );
  const disclaimer = page.locator("#disclaimer");
  assert.ok(await disclaimer.isVisible());
  assert.equal(await disclaimer.textContent(), analysis.disclaimer_text_ja);
  assert.ok(await canvas.isVisible());
  assert.ok(await page.locator("#kinematic-chart").isVisible());
  assert.match(await page.locator("#kinematic-curve").getAttribute("d"), /^M.+L/u);

  const pixels = await canvas.evaluate((element) => {
    const { width, height } = element;
    const { data } = element.getContext("2d").getImageData(0, 0, width, height);
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) {
      opaque += Number(data[index] > 0);
    }
    return { opaque, total: width * height };
  });
  assert.ok(
    pixels.opaque > 0 && pixels.opaque < pixels.total,
    "Canvas must paint joints and bones",
  );

  const scrubber = page.locator("#frame-scrubber");
  const frameCount = analysis.pose3d.frames.length;
  assert.equal(Number(await scrubber.getAttribute("max")) + 1, frameCount);
  const samples = await scrubber.evaluate(
    (input, positions) => {
      const canvas = document.querySelector("#skeleton-canvas");
      const chart = document.querySelector("#kinematic-chart");
      const cursor = document.querySelector("#chart-cursor");
      return positions.map((position) => {
        input.valueAsNumber = position;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          skeleton: canvas.dataset.frame,
          chart: chart.dataset.frame,
          marker:
            cursor.getAttribute("visibility") === "visible"
              ? Number(cursor.getAttribute("x1"))
              : null,
          image: canvas.toDataURL(),
        };
      });
    },
    [0, 8, 35, 62, frameCount - 1],
  );
  const expectedFrames = [0, 8, 35, 62, frameCount - 1].map((position) =>
    String(analysis.pose3d.frames[position].frame_index),
  );
  assert.deepEqual(
    samples.map(({ skeleton }) => skeleton),
    expectedFrames,
  );
  const maxSyncDelta = Math.max(
    ...samples.map(({ skeleton, chart }) => Math.abs(Number(skeleton) - Number(chart))),
  );
  assert.equal(maxSyncDelta, 0);
  assert.ok(
    new Set(samples.map(({ image }) => image)).size > 1,
    "Scrubbing must redraw the skeleton",
  );
  assert.deepEqual(
    samples.map(({ marker }) => (marker === null ? null : Math.round(marker))),
    [null, 12, 172, 332, null],
  );
  await page.locator("#orbit-angle").press("End");
  assert.notEqual(await canvas.evaluate((element) => element.toDataURL()), samples.at(-1).image);
  const beforeDrag = await page.locator("#orbit-angle").inputValue();
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2);
  await page.mouse.up();
  assert.notEqual(await page.locator("#orbit-angle").inputValue(), beforeDrag);
  const tamperedUrl = new URL(shareUrl);
  tamperedUrl.searchParams.set("token", invalidToken);
  const tampered = await page.goto(tamperedUrl.href);
  assert.equal(tampered?.status(), 404);
  assert.equal(await tampered.text(), "Not found");
  assert.ok(requests.every((url) => new URL(url).origin === new URL(shareUrl).origin));
  return {
    load_ms: Number(loadMs.toFixed(1)),
    frames: frameCount,
    max_sync_delta: maxSyncDelta,
    share_status_valid: response.status(),
    share_status_tampered: tampered.status(),
  };
}

const store = new MemoryStateStore({
  teams: [{ id: teamId, teamId, orgId: "e2e-org", name: "E2E" }],
  athletes: [{ id: athleteId, teamId, name: "E2E athlete", shareConsent: true }],
  trials: [{ id: trialId, teamId, athleteId, title: "Calibrated running" }],
  memberships: [{ userId: coachId, teamId, role: "Coach", active: true }],
  guardians: [],
  analyses: [],
  evidence: [],
  links: [],
});
let now = Date.now();
let api;
let web;
let browser;
try {
  api = await startApiServer({
    policy: new AccessPolicy(store, createSecretKey(randomBytes(32)), () => now),
    authenticate: ({ headers }) =>
      headers.authorization === `Bearer ${coachId}` ? coachId : undefined,
    worker: new UvMotionWorker(),
  });
  web = await startShareWebServer({ apiBaseUrl: baseUrl(api) });
  const mobile = new WalkingSkeletonMobileClient({
    apiBaseUrl: baseUrl(api),
    teamId,
    authToken: coachId,
  });
  const capture = calibratedCapture();
  const analysis = await mobile.uploadAndAnalyze(JSON.parse(JSON.stringify(capture)));
  assert.equal(analysis.pose3d.coordinate_frame, "CalibratedWorld3D");
  assert.equal(analysis.pose3d.is_metric_calibrated, true);
  assert.equal(analysis.pose3d.frames.length, capture.views[0].frames.length);
  assert.ok(
    analysis.kinematic_metrics.scalar_metrics.some(({ value_or_null }) =>
      Number.isFinite(value_or_null),
    ),
  );
  assert.ok(analysis.kinematic_metrics.normalized_waveforms.length > 0);
  const preview = mobile.buildSkeletonPreview(analysis.pose3d, 0);
  assert.ok(preview.points.length > 0 && preview.segments.length > 0);
  assert.ok(preview.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));

  const expiresAt = now + 60_000;
  const { shareLinkId, token, shareUrl } = await mobile.issueShareUrl({
    teamId,
    analysisRevisionId: analysis.analysis_revision_id,
    evidenceSnapshotId: analysis.evidence_snapshot_id,
    expiresAt,
    shareWebBaseUrl: baseUrl(web),
  });
  const poseUrl = `${baseUrl(api)}/share/${shareLinkId}/pose3d?token=${encodeURIComponent(token)}`;
  const pinnedPose = await fetch(poseUrl);
  assert.equal(pinnedPose.status, 200);
  assert.deepEqual(await pinnedPose.json(), analysis.pose3d);
  store.update(({ analyses }) => {
    analyses[0].pose3d.frames[0].landmarks[0].x += 0.5;
  });
  assert.deepEqual(await fetch(poseUrl).then((response) => response.json()), analysis.pose3d);

  browser = await chromium.launch();
  const invalidToken = `A${token}`;
  const viewer = await verifyViewer(browser, shareUrl, invalidToken, analysis);
  for (const path of [poseUrl.replace(token, invalidToken), `${poseUrl}&teamId=other-team`]) {
    const denied = await fetch(path);
    assert.equal(denied.status, 404);
    assert.equal(await denied.text(), '{"error":"not_found"}');
  }
  now = expiresAt;
  assert.equal(await fetch(poseUrl).then((response) => response.status), 404);
  assert.equal(await fetch(shareUrl).then((response) => response.status), 404);
  console.log(
    JSON.stringify(
      {
        ...viewer,
        analysis_revision_id: analysis.analysis_revision_id,
        browser: `Chromium ${browser.version()}`,
        viewport,
        is_mobile: true,
        network: "Local loopback, unthrottled",
        fixture: "Synthetic 2-camera DLT run at 60 fps",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await Promise.all([web, api].filter(Boolean).map(close));
  }
}
