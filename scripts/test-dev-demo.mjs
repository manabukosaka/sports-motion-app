import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const prefix = "DEMO_READY_JSON=";
const windows = process.platform === "win32";
const child = spawn(
  process.execPath,
  ["scripts/dev-demo.mjs", "--ephemeral-ports", "--json-ready", "--no-build"],
  { cwd: repository, detached: !windows },
);
const started = performance.now();
const readyLine = Promise.withResolvers();
const finished = new Promise((resolve) => {
  child.once("error", (error) => resolve({ error }));
  child.once("close", (code, signal) => resolve({ code, signal }));
});
child.stdin.on("error", (error) => readyLine.reject(error));
function requestQuit() {
  if (!child.stdin.writableEnded) child.stdin.end("quit\n");
}
process.on("SIGINT", requestQuit);
process.on("SIGTERM", requestQuit);
const output = createInterface({ input: child.stdout });
let readyCount = 0;
let diagnostics = "";
function recordOutput(chunk) {
  diagnostics = (diagnostics + chunk).slice(-8000);
}
child.stderr.setEncoding("utf8").on("data", recordOutput);
output.on("line", (line) => {
  if (!line.startsWith(prefix)) {
    recordOutput(`${line}\n`);
    return;
  }
  readyCount += 1;
  try {
    readyLine.resolve(JSON.parse(line.slice(prefix.length)));
  } catch (error) {
    readyLine.reject(error);
  }
});

function deadline(ms, message) {
  return setTimeout(ms, undefined, { ref: false }).then(() => {
    throw new Error(message);
  });
}

async function request(label, url, expectedStatus, expectedType, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expectedStatus, label);
  assert.match(response.headers.get("content-type") ?? "", expectedType, label);
  return response;
}

function tampered(url) {
  const changed = new URL(url);
  changed.searchParams.set("token", "tampered-invalid-token");
  return changed;
}

function assertShareHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function assertNonDiagnostic(html) {
  assert.match(html, /data-non-diagnostic="true"/u);
  assert.match(html, /医療診断|非診断/u);
}

const htmlType = /^text\/html\b/u;
const jsonType = /^application\/json\b/u;
const textType = /^text\/plain\b/u;
const svgType = /^image\/svg\+xml\b/u;
const statuses = {};
try {
  const ready = await Promise.race([
    readyLine.promise,
    finished.then(({ code, signal, error }) => {
      throw error ?? new Error(`Demo exited before readiness (${signal ?? code})`);
    }),
    deadline(120_000, "Demo did not become ready within 120 seconds"),
  ]);
  const startupMs = Math.round(performance.now() - started);
  const { apiBaseUrl, teamId, trialId, bearerToken, stateDir } = ready;
  const trialUrl = `${apiBaseUrl}/teams/${teamId}/trials/${trialId}`;
  const unauthorized = await request("API requires Bearer authentication", trialUrl, 401, jsonType);
  assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  statuses.api_unauthenticated = unauthorized.status;

  const authenticated = await request("API returns the seeded trial", trialUrl, 200, jsonType, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  assert.equal((await authenticated.json()).id, trialId);
  statuses.api_authenticated = authenticated.status;

  const report = await request("Signed share report", ready.shareWebUrl, 200, htmlType);
  assertShareHeaders(report);
  const reportHtml = await report.text();
  assert.match(reportHtml, /id="skeleton-canvas"/u);
  assertNonDiagnostic(reportHtml);
  statuses.share_report = report.status;

  const invalidReport = await request(
    "Tampered report token",
    tampered(ready.shareWebUrl),
    404,
    textType,
  );
  assertShareHeaders(invalidReport);
  assert.equal(await invalidReport.text(), "Not found");
  statuses.share_report_tampered = invalidReport.status;

  const card = await request("Signed LINE card", ready.shareCardUrl, 200, svgType);
  assertShareHeaders(card);
  assert.match(await card.text(), /<svg\b[^>]*viewBox="0 0 1200 630"/u);
  statuses.share_card = card.status;

  const invalidCard = await request(
    "Tampered LINE card token",
    tampered(ready.shareCardUrl),
    404,
    textType,
  );
  assertShareHeaders(invalidCard);
  assert.equal(await invalidCard.text(), "Not found");
  statuses.share_card_tampered = invalidCard.status;

  const comparison = await request("Two-trial comparison", ready.comparisonUrl, 200, htmlType);
  assertShareHeaders(comparison);
  const comparisonHtml = await comparison.text();
  assertNonDiagnostic(comparisonHtml);
  assert.match(comparisonHtml, /id="compare-scrubber"/u);
  for (const id of ["baseline-curve", "target-curve"]) {
    assert.match(comparisonHtml, new RegExp(`id="${id}"[^>]*d="M[^"]+L`, "u"));
  }
  assert.match(comparisonHtml, /接地直後の膝の位置/u);
  assert.match(comparisonHtml, /膝の曲がり方を比べましょう/u);
  statuses.share_comparison = comparison.status;

  const mobile = await request("Expo Web entry", ready.mobileWebUrl, 200, htmlType);
  assert.equal(mobile.headers.get("cache-control"), "no-store");
  const scriptPath = /<script\b[^>]*\bsrc=["']([^"']+)["']/iu.exec(await mobile.text())?.[1];
  assert.ok(scriptPath, "Expo Web entry must reference a script");
  const scriptUrl = new URL(scriptPath, ready.mobileWebUrl);
  assert.equal(scriptUrl.origin, new URL(ready.mobileWebUrl).origin);
  const script = await request("Expo Web JavaScript bundle", scriptUrl, 200, /javascript/iu);
  assert.equal(script.headers.get("cache-control"), "no-store");
  const bundleBytes = (await script.arrayBuffer()).byteLength;
  assert.ok(bundleBytes > 0);
  statuses.mobile_html = mobile.status;
  statuses.mobile_script = script.status;

  const configUrl = new URL("/demo-config.json", ready.mobileWebUrl);
  const configResponse = await request("Live mobile demo config", configUrl, 200, jsonType);
  assert.equal(configResponse.headers.get("cache-control"), "no-store");
  assert.equal(configResponse.headers.get("referrer-policy"), "no-referrer");
  const config = await configResponse.json();
  assert.equal(config.apiBaseUrl, "/demo-api");
  assert.equal(config.teamId, teamId);
  assert.equal(config.bearerToken, bearerToken);
  assert.equal(config.shareWebBaseUrl, new URL(ready.shareWebUrl).origin);
  assert.equal(config.pose3d.coordinate_frame, "CalibratedWorld3D");
  assert.equal(config.pose3d.is_metric_calibrated, true);
  assert.equal(config.pose3d.frames.length, 80);
  assert.equal(config.rawPose2d.trial_id, trialId);
  assert.equal(config.rawPose2d.frames.length, 80);
  assert.equal(config.kinematic_metrics.analysis_revision_id, config.analysis_revision_id);
  assert.ok(config.kinematic_metrics.normalized_waveforms.length);
  statuses.mobile_config = configResponse.status;

  const crossOrigin = await request(
    "Cross-origin demo config is denied",
    configUrl,
    403,
    jsonType,
    {
      headers: { Origin: "https://example.invalid" },
    },
  );
  statuses.mobile_config_cross_origin = crossOrigin.status;

  const deniedWrite = await request(
    "Proxy only accepts workflow mutations",
    new URL(`/demo-api/teams/${teamId}/trials/${trialId}/analyze`, ready.mobileWebUrl),
    405,
    jsonType,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  statuses.proxy_unexpected_write = deniedWrite.status;

  const issueUrl = new URL(`/demo-api/teams/${teamId}/share-links`, ready.mobileWebUrl);
  const issueOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: configUrl.origin },
    body: JSON.stringify({
      analysisRevisionId: config.analysis_revision_id,
      evidenceSnapshotId: config.evidence_snapshot_id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }),
  };
  const proxyDenied = await request(
    "Proxy preserves the authentication guard",
    issueUrl,
    404,
    jsonType,
    issueOptions,
  );
  statuses.proxy_share_unauthenticated = proxyDenied.status;
  const issued = await request(
    "Issue a new share link through mobile proxy",
    issueUrl,
    201,
    jsonType,
    {
      ...issueOptions,
      headers: { ...issueOptions.headers, Authorization: `Bearer ${config.bearerToken}` },
    },
  );
  const link = await issued.json();
  assert.notEqual(link.shareLinkId, ready.shareLinkId);
  assert.ok(link.token);
  statuses.proxy_share_issued = issued.status;

  const signedUrl = new URL(
    `/share/${encodeURIComponent(link.shareLinkId)}`,
    config.shareWebBaseUrl,
  );
  signedUrl.searchParams.set("token", link.token);
  const mobileReport = await request("Newly issued signed report", signedUrl, 200, htmlType);
  assertShareHeaders(mobileReport);
  const mobileReportHtml = await mobileReport.text();
  assert.match(mobileReportHtml, /id="skeleton-canvas"/u);
  assertNonDiagnostic(mobileReportHtml);
  statuses.proxy_share_report = mobileReport.status;

  const state = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  assert.ok(state.links.some(({ id }) => id === ready.shareLinkId));
  const analyzedFrames = state.analyses.map(({ pose3d }) => {
    assert.equal(pose3d.coordinate_frame, "CalibratedWorld3D");
    assert.equal(pose3d.is_metric_calibrated, true);
    return pose3d.frames.length;
  });
  assert.deepEqual(analyzedFrames, [80, 80]);

  const stopping = performance.now();
  requestQuit();
  const exit = await Promise.race([finished, deadline(5000, "Demo did not exit after quit")]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(readyCount, 1, "Demo must emit exactly one readiness record");
  await assert.rejects(access(stateDir), { code: "ENOENT" });
  console.log(
    JSON.stringify({
      checks_passed: Object.keys(statuses).length,
      statuses,
      python_calibrated_frames: analyzedFrames,
      mobile_bundle_bytes: bundleBytes,
      startup_ms: startupMs,
      shutdown_ms: Math.round(performance.now() - stopping),
      exit_code: exit.code,
      ephemeral_state_removed: true,
    }),
  );
} catch (error) {
  console.error(error);
  if (diagnostics.trim()) console.error(diagnostics.trimEnd());
  process.exitCode = 1;
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    requestQuit();
    const exit = await Promise.race([finished, setTimeout(5000, null, { ref: false })]);
    if (exit === null && child.exitCode === null && child.signalCode === null) {
      if (windows) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await once(killer, "close");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
      await finished;
    }
  }
  output.close();
  process.off("SIGINT", requestQuit);
  process.off("SIGTERM", requestQuit);
}
