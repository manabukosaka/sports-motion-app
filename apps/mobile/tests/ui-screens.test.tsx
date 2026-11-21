import type { EvidenceCatalog } from "@sports-motion/contracts";
import { loadEvidenceCatalog } from "@sports-motion/evidence";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import {
  CaptureScreen,
  type CaptureSelection,
  ComparisonScreen,
  computeLoupeViewport,
  EditingStudioScreen,
  issueSharePreview,
  ShareScreen,
  SportsMotionApp,
  TeamDashboardScreen,
  WalkingSkeletonMobileClient,
} from "../src/index.js";
import { createDemo } from "../src/ui/demo.js";

const selection: CaptureSelection = { movement: "running", coordinateFrame: "HipRelative3D" };
const capture = {
  selection,
  onSelect: () => undefined,
  queue: [{ ...selection, capture_id: "persisted-offline-01", status: "QueuedOffline" }] as const,
};

function evidenceFixture() {
  const catalog = loadEvidenceCatalog();
  const study: EvidenceCatalog["studies"][number] = {
    id: "ui_test_fixture",
    domain: "running",
    authors: ["Fixture author"],
    year: 2026,
    journal: "Synthetic fixture",
    title: "Synthetic fixture for UI verification",
    doi: "10.0000/mobile-ui-fixture",
    measurement_modality: "optical_mocap",
    population_notes: "Synthetic runners",
    metrics_covered: ["run_knee_flexion_extension_angle"],
    extraction_status: "verified_normative",
    comparability_bias_note: "合成データ",
  };
  const metric = {
    status: "verified_normative",
    metric_id: "run_knee_flexion_extension_angle",
    event_id: "run_initial_contact",
    unit: "deg",
    anatomical_plane: "sagittal",
    source_doi: study.doi,
    sample_size: 20,
    source_locator: "Synthetic Table 1",
    cohort_notes: "Synthetic runners",
    non_diagnostic_flag: true,
  } as const;
  catalog.studies.push(study);
  catalog.normative_metrics.push(
    { ...metric, stat_type: "mean_sd", values: { mean: 19, sd: 4 } },
    { ...metric, stat_type: "median_iqr", values: { median: 20, q1: 16, q3: 24 } },
  );
  return loadEvidenceCatalog(catalog);
}

test("shows three movements, camera choices, and the persisted capture state in the default Coach tab", () => {
  const html = renderToStaticMarkup(<SportsMotionApp {...createDemo()} capture={capture} />);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toMatch(/aria-pressed="true"[^>]*>コーチ<\/button>/u);
  for (const label of [
    "野球投球",
    "ランニング",
    "ジャンプ・着地",
    "参考角度",
    "実寸3D",
    "QueuedOffline",
    "persisted-offline-01",
  ]) {
    expect(html).toContain(label);
  }
  const twoCamera = renderToStaticMarkup(
    <CaptureScreen
      {...capture}
      selection={{ ...selection, coordinateFrame: "CalibratedWorld3D" }}
      mode="researcher"
    />,
  );
  expect(twoCamera).toContain("DLTポールまたはチェッカーボード");
  expect(twoCamera).toContain("CalibratedWorld3D");
});

test("progressively discloses source statistics, provenance, and gated research exports", () => {
  const demo = createDemo();
  const comparison = {
    ...demo.comparison,
    catalog: evidenceFixture(),
    cutoffsHz: { trunk_lower: 8 },
  };
  const coachComparison = renderToStaticMarkup(
    <SportsMotionApp
      {...demo}
      comparison={comparison}
      capture={capture}
      initialScreen="comparison"
    />,
  );
  const researchComparison = renderToStaticMarkup(
    <SportsMotionApp
      {...demo}
      comparison={comparison}
      capture={capture}
      initialMode="researcher"
      initialScreen="comparison"
    />,
  );
  const coachTeam = renderToStaticMarkup(<TeamDashboardScreen {...demo.team} mode="coach" />);
  const researchTeam = renderToStaticMarkup(
    <TeamDashboardScreen {...demo.team} mode="researcher" />,
  );
  expect(coachComparison).toContain("研究参加者");
  expect(coachComparison).toContain("フォームの確認ポイント");
  expect(coachTeam).toContain("初回との差 3.00 deg");
  for (const label of [
    "DOI",
    "pipeline_version",
    "filter_spec_version",
    "calibration_id",
    "coordinate_revision_id",
    "カットオフ",
    "percentile",
    "IQR",
    "CSV",
    ".trc",
    ".mot",
  ]) {
    expect(coachComparison + coachTeam).not.toContain(label);
    expect(researchComparison + researchTeam).toContain(label);
  }
  expect(researchComparison).toMatch(/aria-pressed="true"[^>]*>研究者<\/button>/u);
  expect(researchComparison).toContain("DOI 10.0000/mobile-ui-fixture · n = 20");
  expect(researchComparison).toContain("z = 0.5");
  expect(researchComparison).toContain("IQR = 16〜24 deg");
  expect(researchComparison).toContain("±1SD帯");
  expect(researchTeam).toMatch(/<button[^>]* disabled=""[^>]*>OpenSim \.trc<\/button>/u);
  expect(researchTeam).toContain("実寸で校正した2カメラの試技のみ");
});

test.each([
  "coach",
  "researcher",
] as const)("keeps the non-diagnostic text visible in %s mode", (initialMode) => {
  const demo = createDemo();
  for (const [initialScreen, count] of [
    ["editing", 1],
    ["comparison", 2],
    ["team", 1],
    ["share", 1],
  ] as const) {
    const html = renderToStaticMarkup(
      <SportsMotionApp
        {...demo}
        capture={capture}
        initialMode={initialMode}
        initialScreen={initialScreen}
      />,
    );
    expect(html.match(/data-non-diagnostic="true"/gu)).toHaveLength(count);
    expect(html).toContain(demo.share.analysis.disclaimer_text_ja);
  }
});

test("comparison reflects synchronized controller seeking and playback speed", () => {
  const { comparison } = createDemo();
  comparison.session.seekPercent(50);
  comparison.session.setPlaybackRate(0.25);
  const html = renderToStaticMarkup(<ComparisonScreen {...comparison} mode="coach" />);
  expect(html).toContain("50.0% · 基準フレーム 24 · 今回フレーム 24");
  expect(html).toMatch(/aria-pressed="true"[^>]*>0\.25x<\/button>/u);
});

test("editing displays anomaly flags and the computed finger-free loupe after a controller transition", () => {
  const { editing } = createDemo();
  const html = renderToStaticMarkup(<EditingStudioScreen {...editing} />);
  const { viewport, fingertipRadius } = computeLoupeViewport(156, 178, 360, 240);
  expect(html).toContain("低信頼度・欠測");
  expect(html).toContain(`data-loupe-x="${viewport.x}"`);
  expect(html).toContain(`data-loupe-y="${viewport.y}"`);
  expect(178 - viewport.y - viewport.height).toBeGreaterThanOrEqual(fingertipRadius);
  const { controller } = editing;
  const missingFrame = controller.effectivePose2d.frames[1];
  if (!missingFrame) throw new Error("Missing test frame");
  controller.interpolateRange("ui-fill", {
    landmarkId: "right_knee",
    startFrame: missingFrame.frame_index,
    endFrame: missingFrame.frame_index,
  });
  expect(renderToStaticMarkup(<EditingStudioScreen {...editing} />)).not.toContain("欠測");
});

afterEach(() => vi.unstubAllGlobals());

test("share requires consent before issuing and pins analysis, evidence, and expiry through the verified client", async () => {
  const { share } = createDemo();
  const post = vi
    .fn()
    .mockResolvedValue(Response.json({ shareLinkId: "link-1", token: "signed-token" }));
  vi.stubGlobal("fetch", post);
  const client = new WalkingSkeletonMobileClient({
    apiBaseUrl: "https://api.example.test",
    teamId: "team-1",
    authToken: "test",
  });
  const connection = { client, teamId: "team-1", shareWebBaseUrl: "https://share.example.test/" };
  const denied = { ...share, connection };
  const html = renderToStaticMarkup(<ShareScreen {...denied} />);
  expect(html).toContain("選手の共有同意が必要です。");
  expect(html).toMatch(/<button[^>]* disabled=""[^>]*>共有リンクを発行<\/button>/u);
  await expect(issueSharePreview(denied, "7日間")).rejects.toThrow("consent");
  expect(post).not.toHaveBeenCalled();

  const allowed = { ...denied, shareConsent: true };
  expect(renderToStaticMarkup(<ShareScreen {...allowed} />)).toContain("30日間");
  const now = Date.parse("2026-11-21T00:00:00Z");
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const preview = await issueSharePreview(allowed, "7日間", now);
  expect(post).toHaveBeenCalledWith(
    "https://api.example.test/teams/team-1/share-links",
    expect.objectContaining({
      body: JSON.stringify({
        analysisRevisionId: share.analysis.analysis_revision_id,
        evidenceSnapshotId: share.analysis.evidence_snapshot_id,
        expiresAt,
      }),
    }),
  );
  expect(preview).toEqual({
    expiresAt,
    shareUrl: "https://share.example.test/share/link-1?token=signed-token",
    summaryCardUrl: "https://share.example.test/share/link-1/card.svg?token=signed-token",
    lineUrl:
      "https://line.me/R/share?text=https%3A%2F%2Fshare.example.test%2Fshare%2Flink-1%3Ftoken%3Dsigned-token",
  });
});
