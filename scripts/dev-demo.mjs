import { spawn } from "node:child_process";
import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = fileURLToPath(new URL("../", import.meta.url));
const mobileDist = join(repository, "apps", "mobile", "dist");
const host = "127.0.0.1";
const teamId = "demo-team";
const athleteId = "demo-runner";
const trialId = "demo-run-current-v2";
const baselineTrialId = "demo-run-baseline-v2";
const userId = "demo-admin";
const teamPath = `/teams/${teamId}`;
const trialPath = `${teamPath}/trials/${trialId}`;
const sessionDurationMs = 8 * 60 * 60 * 1000;
const mobileApiWrites = new Set([
  `/demo-api${teamPath}/share-links`,
  `/demo-api${trialPath}/revisions`,
]);

const workspaceEntries = [
  "apps/api/dist/index.js",
  "apps/share-web/dist/index.js",
  "packages/coaching/dist/packages/coaching/src/index.js",
  "packages/contracts/dist/packages/contracts/src/index.js",
  "packages/editing/dist/packages/editing/src/index.js",
  "packages/evidence/dist/packages/evidence/src/index.js",
];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".map", "application/json; charset=utf-8"],
]);

function portNumber(flag, value) {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new RangeError(`--${flag} must be a port from 0 to 65535`);
  }
  return port;
}

async function runPnpm(args, env = process.env) {
  const child =
    process.platform === "win32"
      ? spawn(`pnpm.cmd ${args.join(" ")}`, { shell: true, cwd: repository, env })
      : spawn("pnpm", args, { cwd: repository, env });
  child.stdin.end();
  child.stdout.pipe(process.stderr, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const [code, signal] = await once(child, "close");
  if (code !== 0) throw new Error(`pnpm ${args.join(" ")} exited with ${signal ?? code}`);
}

function baseUrl(server) {
  return `http://${host}:${server.address().port}`;
}

async function listen(server, port) {
  server.listen(port, host);
  await once(server, "listening");
  return server;
}

async function closeServers(servers) {
  const closed = await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
        }),
    ),
  );
  const failure = closed.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

function demoApiServer(options, sharePolicy, handleApiRequest) {
  // The demo route names wrap the existing team-scoped API and its request validation.
  const aliases = new Map([
    ["POST /teams", ["PUT", `${teamPath}/teams/${teamId}`]],
    [`POST ${teamPath}/athletes`, ["PUT", `${teamPath}/athlete-profiles/${athleteId}`]],
    [`POST ${teamPath}/trials`, ["PUT", `${teamPath}/trial-videos/${trialId}`]],
    [`POST ${trialPath}/share-links`, ["POST", `${teamPath}/share-links`]],
  ]);
  function handle(request, response) {
    const alias = aliases.get(`${request.method} ${request.url}`);
    if (alias) {
      const routeOptions = request.url === `${trialPath}/share-links` ? sharePolicy : options;
      [request.method, request.url] = alias;
      void handleApiRequest(request, response, routeOptions);
      return;
    }
    if (
      request.method === "GET" &&
      (request.url === trialPath || request.url === `${teamPath}/trials/demo-run-current`)
    ) {
      const hasBody =
        Boolean(request.headers["transfer-encoding"]) ||
        (request.headers["content-length"] ?? "0") !== "0";
      if (!hasBody && !options.authenticate(request)) {
        response.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "WWW-Authenticate": "Bearer",
        });
        response.end('{"error":"unauthorized"}');
        return;
      }
      request.url = `${teamPath}/trial-videos/${trialId}`;
    }
    const policy =
      request.method === "POST" && request.url.split("?", 1)[0] === `${teamPath}/share-links`
        ? sharePolicy
        : options;
    void handleApiRequest(request, response, policy);
  }
  return createServer(handle).on("checkContinue", handle);
}

function runningJoints(frame, strideEnd, strideScale) {
  const phase = ((frame - 8) / (strideEnd - 8)) * 2 * Math.PI;
  const pelvis = [0, 0.86 + 0.02 * Math.cos(phase * 2), 0];
  const offset = ([x, y, z], right, up, forward) => [x + right, y + up, z - forward];
  const segment = (origin, length, angle) =>
    offset(origin, 0, -length * Math.cos(angle), length * Math.sin(angle));
  const joints = { pelvis, nose: offset(pelvis, 0, 0.72, 0.13) };
  for (const [side, sign] of [
    ["left", -1],
    ["right", 1],
  ]) {
    const step = phase + (sign === 1 ? 0 : Math.PI);
    const swing = Math.max(0, Math.sin(step - 2.05));
    const hip = offset(pelvis, sign * 0.1, 0, 0);
    const thigh = strideScale * (0.12 + 0.48 * Math.cos(step));
    const flexion = 0.36 + 0.18 * Math.sin(2 * step) + strideScale * 1.08 * swing ** 2;
    const knee = segment(hip, 0.41, thigh);
    const ankle = segment(knee, 0.39, thigh - flexion);
    const shoulder = offset(pelvis, sign * 0.19, 0.49, 0.08 + sign * 0.04 * Math.sin(phase));
    const armAngle = -0.35 - 0.56 * Math.cos(step);
    const elbow = segment(shoulder, 0.285, armAngle);
    const wrist = segment(elbow, 0.255, armAngle + 1.35);
    Object.assign(joints, {
      [`${side}_hip`]: hip,
      [`${side}_knee`]: knee,
      [`${side}_ankle`]: ankle,
      [`${side}_shoulder`]: shoulder,
      [`${side}_elbow`]: elbow,
      [`${side}_wrist`]: wrist,
    });
    if (sign === 1) {
      joints.right_foot_index = offset(ankle, 0, -0.04, 0.13);
      joints.right_knee_left_epicondyle = offset(knee, -0.04, 0, 0);
      joints.right_knee_right_epicondyle = offset(knee, 0.04, 0, 0);
      joints.right_ankle_left_malleolus = offset(ankle, -0.03, 0, 0);
      joints.right_ankle_right_malleolus = offset(ankle, 0.03, 0, 0);
    }
  }
  return Object.entries(joints);
}

function calibratedRun(calibration, id, strideEnd, strideScale) {
  const fps = 60;
  return {
    capture_id: `${id}-capture`,
    analysis_job_id: `${id}-job`,
    raw_revision_id: `${id}-raw`,
    calibration,
    movement: "running",
    events: [
      ["run_initial_contact", 8],
      ["run_next_initial_contact", strideEnd],
    ].map(([event_id, frame_index]) => ({
      event_id,
      frame_index,
      timestamp_sec: frame_index / fps,
      detection_mode: "manual",
      side: "right",
    })),
    views: calibration.views.map(({ view_id, dlt_params: p }, camera) => ({
      contract_version: calibration.contract_version,
      trial_id: id,
      view_id,
      fps,
      width_px: 480,
      height_px: 320,
      lens_undistorted: true,
      coordinate_frame: "Image2D",
      unit: "px",
      frames: Array.from({ length: 80 }, (_, frame_index) => ({
        frame_index,
        timestamp_sec: frame_index / fps,
        landmarks: runningJoints(frame_index, strideEnd, strideScale).map(
          ([landmark_id, point]) => {
            const [x, y, z] = point;
            const denominator = p[8] * x + p[9] * y + p[10] * z + 1;
            const missing = camera === 0 && frame_index === 24 && landmark_id === "right_knee";
            return {
              landmark_id,
              x: missing ? null : (p[0] * x + p[1] * y + p[2] * z + p[3]) / denominator,
              y: missing ? null : (p[4] * x + p[5] * y + p[6] * z + p[7]) / denominator,
              confidence: missing ? null : 1,
              source: "tracker_raw",
              missing_reason: missing ? "occluded" : null,
            };
          },
        ),
      })),
    })),
  };
}

async function seedDemo(apiBaseUrl, bearerToken, store, stopping) {
  async function write(method, path, body) {
    stopping.throwIfAborted();
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(65_000),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(result)}`);
    }
    return result;
  }

  const state = store.read();
  if (!state.teams.find(({ id }) => id === teamId)?.name) {
    await write("POST", "/teams", { name: "青葉ランニングクラブ" });
  }
  if (!state.athletes.find(({ id }) => id === athleteId)?.name) {
    await write("POST", `${teamPath}/athletes`, { name: "青葉 はる" });
  }
  if (!state.trials.some(({ id }) => id === trialId)) {
    await write("POST", `${teamPath}/trials`, { athleteId, title: "ランニング・最新試技" });
  }
  if (!state.trials.some(({ id }) => id === baselineTrialId)) {
    await write("PUT", `${teamPath}/trial-videos/${baselineTrialId}`, {
      athleteId,
      title: "ランニング・基準試技",
    });
  }
  const calibration = JSON.parse(
    await readFile(
      new URL("../packages/contracts/fixtures/valid/calibration.dlt.json", import.meta.url),
      "utf8",
    ),
  );
  calibration.contract_version = "1.0.0";
  calibration.views = calibration.views.map((view, index) => {
    const yaw = index === 0 ? 0.06 : -0.74;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const centerX = index === 0 ? 238 : 207;
    const centerY = 303;
    const focal = 164;
    const depthX = sin / 5;
    const depthZ = cos / 5;
    return {
      ...view,
      view_id: index === 0 ? "front_oblique" : "side_oblique",
      intrinsics: { fx_px: focal, fy_px: focal, cx_px: centerX, cy_px: centerY },
      dlt_params: [
        -focal * cos + centerX * depthX,
        0,
        focal * sin + centerX * depthZ,
        centerX,
        centerY * depthX,
        -focal,
        centerY * depthZ,
        centerY,
        depthX,
        0,
        depthZ,
      ],
    };
  });
  const baseline = await write(
    "POST",
    `${teamPath}/trials/${baselineTrialId}/analyze`,
    calibratedRun(calibration, baselineTrialId, 58, 0.8),
  );
  const input = calibratedRun(calibration, trialId, 62, 1);
  const target = await write("POST", `${trialPath}/analyze`, input);
  const share = await write("POST", `${trialPath}/share-links`, {
    analysisRevisionId: target.analysis_revision_id,
    evidenceSnapshotId: target.evidence_snapshot_id,
    expiresAt: Date.now() + sessionDurationMs,
  });
  return { baseline, target, share, input };
}

async function mobileAsset(root, request) {
  try {
    const pathname = decodeURIComponent(request.url.split("?", 1)[0]);
    const segments = pathname === "/" ? ["index.html"] : pathname.slice(1).split("/");
    if (
      !pathname.startsWith("/") ||
      /[\\:\p{Cc}]/u.test(pathname) ||
      segments.some((part) => !part || part === "." || part === "..")
    ) {
      return;
    }
    const file = await realpath(join(root, ...segments));
    const fromRoot = relative(root, file);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return;

    const info = await stat(file);
    if (!info.isFile()) return;
    return {
      type: mimeTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream",
      size: info.size,
      body: request.method === "HEAD" ? undefined : await readFile(file),
    };
  } catch (error) {
    if (
      error instanceof URIError ||
      ["ENOENT", "ENOTDIR", "EACCES", "EINVAL", "ENAMETOOLONG", "ELOOP", "EPERM"].includes(
        error.code,
      )
    ) {
      return;
    }
    throw error;
  }
}

function allowMobileRequest(request) {
  const port = request.socket.localPort;
  const hostHeader = request.headers.host;
  return (
    (hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`) &&
    (!request.headers.origin || request.headers.origin === `http://${hostHeader}`) &&
    (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin")
  );
}

function proxyMobileApi(request, response, apiPort) {
  const headers = {};
  for (const key of ["authorization", "content-type", "content-length"]) {
    if (request.headers[key] !== undefined) headers[key] = request.headers[key];
  }
  const upstream = requestHttp(
    {
      hostname: host,
      port: apiPort,
      method: request.method,
      path: request.url.slice("/demo-api".length),
      headers,
    },
    (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      void pipeline(reply, response).catch(() => upstream.destroy());
    },
  );
  upstream.setTimeout(65_000, () => upstream.destroy());
  upstream.on("error", () => {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response
      .writeHead(502, { "Content-Type": "application/json; charset=utf-8" })
      .end('{"error":"demo_api_unavailable"}');
  });
  request.once("error", () => upstream.destroy());
  response.once("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
}

async function startMobileServer(port, apiPort, config) {
  const root = await realpath(mobileDist);
  return listen(
    createServer(async (request, response) => {
      try {
        const pathname = request.url.split("?", 1)[0];
        const isConfig = pathname === "/demo-config.json";
        const isProxy = pathname.startsWith("/demo-api/");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if ((isConfig || isProxy) && !allowMobileRequest(request)) {
          response
            .writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
            .end('{"error":"forbidden"}');
          return;
        }
        if (isConfig && (request.method === "GET" || request.method === "HEAD")) {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Referrer-Policy": "no-referrer",
          });
          response.end(request.method === "HEAD" ? undefined : JSON.stringify(config()));
          return;
        }
        if (isProxy) {
          const read = request.method === "GET" || request.method === "HEAD";
          const write = request.method === "POST" && mobileApiWrites.has(request.url);
          if (!read && !write) {
            response
              .writeHead(405, { "Content-Type": "application/json; charset=utf-8" })
              .end('{"error":"method_not_allowed"}');
            return;
          }
          proxyMobileApi(request, response, apiPort);
          return;
        }
        const asset =
          request.method === "GET" || request.method === "HEAD"
            ? await mobileAsset(root, request)
            : undefined;
        if (asset) {
          response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.size });
          response.end(asset.body);
        } else {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
        }
      } catch (error) {
        console.error(`Mobile Web asset error: ${error.message}`);
        response.writeHead(500, { "Cache-Control": "no-store" }).end();
      }
    }),
    port,
  );
}

function announce(ready, jsonReady) {
  if (jsonReady) {
    console.log(`DEMO_READY_JSON=${JSON.stringify(ready)}`);
    return;
  }
  console.log(`
Sports Motion App local demo
  Mobile Web:       ${ready.mobileWebUrl}
  Share Web 3D:     ${ready.shareWebUrl}
  LINE SVG card:   ${ready.shareCardUrl}
  Compare trials:  ${ready.comparisonUrl}
  API trial:       ${ready.apiBaseUrl}${trialPath}
  Bearer token:    ${ready.bearerToken}
  State directory: ${ready.stateDir}

Press Ctrl+C or enter quit to stop.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "port-api": { type: "string", default: "4010" },
      "port-share": { type: "string", default: "4020" },
      "port-mobile": { type: "string", default: "4030" },
      "state-dir": { type: "string" },
      "ephemeral-ports": { type: "boolean" },
      "json-ready": { type: "boolean" },
      "no-build": { type: "boolean" },
      "rebuild-mobile": { type: "boolean" },
    },
  });
  const [apiPort, sharePort, mobilePort] = ["port-api", "port-share", "port-mobile"].map((flag) => {
    const port = portNumber(flag, values[flag]);
    return values["ephemeral-ports"] ? 0 : port;
  });
  const persistent = values["state-dir"] !== undefined;
  if (values["state-dir"] === "") throw new Error("--state-dir requires a non-empty path");
  process.env.UV_PROJECT_ENVIRONMENT ||= join(tmpdir(), "uv-venv-issue-66");

  const servers = [];
  let stateDir;
  let stateLock;
  const shutdown = new AbortController();
  const stopped = Promise.withResolvers();
  const stop = () => {
    shutdown.abort();
    stopped.resolve();
  };
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    if (line.trim() === "quit") stop();
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (
      !values["no-build"] &&
      workspaceEntries.some((path) => !existsSync(join(repository, path)))
    ) {
      await runPnpm(["-r", "run", "build"]);
    }
    if (shutdown.signal.aborted) return;
    if (values["rebuild-mobile"] || !existsSync(join(mobileDist, "index.html"))) {
      await runPnpm(
        ["--filter", "@sports-motion/mobile", "exec", "expo", "export", "--platform", "web"],
        {
          ...process.env,
          EXPO_OFFLINE: "1",
          EXPO_NO_TELEMETRY: "1",
        },
      );
    }
    if (shutdown.signal.aborted) return;

    const [api, web, { compareTwoTrials }] = await Promise.all([
      import("../apps/api/dist/index.js"),
      import("../apps/share-web/dist/index.js"),
      import("../packages/coaching/dist/packages/coaching/src/index.js"),
    ]);
    stateDir = persistent
      ? resolve(values["state-dir"])
      : await mkdtemp(join(tmpdir(), "sports-motion-demo-"));
    if (persistent) {
      await mkdir(stateDir, { recursive: true });
      stateLock = await open(join(stateDir, ".demo.lock"), "wx");
    }
    // Team and athlete identities bootstrap the API's existing update-only records.
    const store = new api.FileStateStore(join(stateDir, "state.json"), {
      memberships: [{ userId, teamId, role: "OrgAdmin", active: true }],
      guardians: [],
      teams: [{ id: teamId, teamId, orgId: "demo-org", name: "" }],
      athletes: [{ id: athleteId, teamId, name: "", shareConsent: true }],
      trials: [],
      analyses: [],
      evidence: [],
      links: [],
    });
    const shareSecret = createSecretKey(randomBytes(32));
    const auth = {
      secret: createSecretKey(randomBytes(32)),
      issuer: "local-demo",
      audience: "api",
    };
    const bearerToken = api.issueBearerToken(
      {
        userId,
        issuer: auth.issuer,
        audience: auth.audience,
        expiresAt: Date.now() + sessionDurationMs,
        tokenId: randomUUID(),
      },
      auth.secret,
    );
    const options = {
      policy: new api.AccessPolicy(store, shareSecret),
      authenticate: api.createBearerAuthenticator(auth),
      worker: new api.UvMotionWorker(),
    };
    class TrialSharePolicy extends api.AccessPolicy {
      issue(actor, team, fields) {
        const analysis = this.read(actor, team, "AnalysisRevision", fields.analysisRevisionId);
        if (analysis?.trialId === trialId) return super.issue(actor, team, fields);
      }
    }
    const shareOptions = { ...options, policy: new TrialSharePolicy(store, shareSecret) };
    const apiServer = await listen(
      demoApiServer(options, shareOptions, api.handleApiRequest),
      apiPort,
    );
    servers.push(apiServer);
    const apiBaseUrl = baseUrl(apiServer);
    const {
      baseline,
      target,
      share,
      input: targetInput,
    } = await seedDemo(apiBaseUrl, bearerToken, store, shutdown.signal);
    if (shutdown.signal.aborted) return;
    const comparison = compareTwoTrials({
      baseline: baseline.kinematic_metrics,
      target: target.kinematic_metrics,
      metricId: "run_knee_flexion_extension_angle",
      intervalId: "run_stride",
      side: "right",
    });
    const html = web.renderTwoTrialComparisonHtml({
      comparison,
      baselineLabel: "基準試技",
      targetLabel: "最新試技",
      annotations: [
        {
          id: "knee-position",
          kind: "label",
          startFrame: 8,
          endFrame: 25,
          points: [{ x: 0.3, y: 0.4 }],
          colorHex: "#047c6d",
          label: "接地直後の膝の位置",
        },
      ],
      comments: [
        {
          id: "stride-review",
          kind: "text",
          frameIndex: 30,
          authorRole: "Coach",
          createdAt: new Date().toISOString(),
          text: "右脚の接地から次の接地まで、膝の曲がり方を比べましょう。",
        },
      ],
    });
    const shareServer = await web.startShareWebServer({
      apiBaseUrl,
      host,
      port: sharePort,
      demoComparisonHtml: () => html,
    });
    servers.push(shareServer);
    if (shutdown.signal.aborted) return;
    const mobileServer = await startMobileServer(mobilePort, apiServer.address().port, () => {
      const state = store.read();
      const revisions = (state.motionJobs ?? [])
        .filter((job) => job.teamId === teamId && job.trialId === trialId && job.coordinateCommit)
        .map((job) => job.coordinateCommit.revision);
      const head = revisions.at(-1)?.revision_id;
      const latest =
        head &&
        state.analyses.find(
          (analysis) =>
            analysis.teamId === teamId &&
            analysis.trialId === trialId &&
            analysis.pose3d?.provenance.coordinate_revision_id === head,
        );
      const evidence =
        latest &&
        state.evidence.find(
          (item) => item.teamId === teamId && item.analysisRevisionId === latest.id,
        );
      return {
        apiBaseUrl: "/demo-api",
        teamId,
        bearerToken,
        athleteId,
        baselineTrialId,
        shareWebBaseUrl: baseUrl(shareServer),
        rawPose2d: targetInput.views[0],
        rawRevisionId: targetInput.raw_revision_id,
        revisions,
        calibration: targetInput.calibration,
        pose3d: latest?.pose3d ?? target.pose3d,
        kinematic_metrics: latest?.summary ?? target.kinematic_metrics,
        baseline_metrics: baseline.kinematic_metrics,
        analysis_revision_id: latest?.id ?? target.analysis_revision_id,
        evidence_snapshot_id: evidence?.id ?? target.evidence_snapshot_id,
        evidence_registry_version: evidence?.registryVersion ?? target.evidence_registry_version,
        disclaimer_text_ja: evidence?.disclaimerTextJa ?? target.disclaimer_text_ja,
        cutoffsHz: latest?.selectedCutoffsHz ?? target.selected_cutoffs_hz,
      };
    });
    servers.push(mobileServer);
    if (shutdown.signal.aborted) return;

    const shareBase = `${baseUrl(shareServer)}/share/${encodeURIComponent(share.shareLinkId)}`;
    const query = `?token=${encodeURIComponent(share.token)}`;
    announce(
      {
        apiBaseUrl,
        shareWebUrl: `${shareBase}${query}`,
        shareCardUrl: `${shareBase}/card.svg${query}`,
        comparisonUrl: `${baseUrl(shareServer)}/demo/compare`,
        mobileWebUrl: `${baseUrl(mobileServer)}/`,
        teamId,
        athleteId,
        trialId,
        shareLinkId: share.shareLinkId,
        bearerToken,
        stateDir,
      },
      values["json-ready"],
    );
    await stopped.promise;
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    input.close();
    process.stdin.pause();
    try {
      await closeServers(servers);
    } finally {
      if (stateLock) {
        await stateLock.close();
        await rm(join(stateDir, ".demo.lock"), { force: true });
      } else if (!persistent && stateDir) {
        await rm(stateDir, { recursive: true, force: true });
      }
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Local demo failed: ${error.message}`);
  process.exitCode = 1;
}
