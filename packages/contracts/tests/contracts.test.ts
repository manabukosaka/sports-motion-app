import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import catalog from "../../../docs/evidence/initial-literature-catalog.json" with { type: "json" };
import dlt from "../fixtures/valid/calibration.dlt.json" with { type: "json" };
import pose2d from "../fixtures/valid/pose2d.json" with { type: "json" };
import share from "../fixtures/valid/share_report.synthetic_comparison.json" with { type: "json" };
import { type ContractKind, readCompatibleContract, validateContract } from "../src/index.js";

const fixtureKinds: readonly ContractKind[] = [
  "pose2d",
  "coordinate_revision",
  "calibration",
  "pose3d",
  "kinematic_metrics",
  "share_report",
];

function fixtures(group: "valid" | "invalid") {
  const root = fileURLToPath(new URL(`../fixtures/${group}/`, import.meta.url));
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const kind = fixtureKinds.find((kind) => entry.name.startsWith(`${kind}.`));
      if (!kind) {
        throw new Error(`Unknown fixture contract: ${entry.name}`);
      }
      const payload: unknown = JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8"));
      return { name: entry.name, kind, payload };
    })
    .sort((first, second) => first.name.localeCompare(second.name, "en"));
}

const valid = fixtures("valid");
const invalid = fixtures("invalid");

describe("shared contract fixtures", () => {
  test("covers every fixture group", () => {
    expect(valid.length).toBeGreaterThanOrEqual(12);
    expect(invalid.length).toBeGreaterThanOrEqual(18);
  });

  test.each(valid)("$name passes and round-trips exactly", ({ kind, payload }) => {
    expect(validateContract(kind, payload)).toBe(true);
    const roundTrip: unknown = JSON.parse(JSON.stringify(payload));
    expect(validateContract(kind, roundTrip)).toBe(true);
    expect(roundTrip).toStrictEqual(payload);
  });

  test.each(invalid)("$name is rejected", ({ kind, payload }) => {
    expect(validateContract(kind, payload)).toBe(false);
  });

  test("accepts the initial catalog of 26 studies", () => {
    expect(validateContract("evidence_catalog", catalog)).toBe(true);
    expect(catalog.studies).toHaveLength(26);
  });
});

const shareV1 = {
  ...share,
  contract_version: "1.0.0",
  kinematic_summary: {
    ...share.kinematic_summary,
    contract_version: "1.0.0",
    provenance: { ...share.kinematic_summary.provenance, contract_version: "1.0.0" },
  },
};

describe("same-MAJOR compatibility", () => {
  test("reads known fields and preserves the original nested input", () => {
    const expected = { ...pose2d, contract_version: "1.9.0" };
    const augmented = {
      ...expected,
      future_camera: "side-b",
      frames: pose2d.frames.map((frame) => ({
        ...frame,
        future_label: "capture",
        landmarks: frame.landmarks.map((point) => ({ ...point, future_weight: 0.9 })),
      })),
    };
    const original = structuredClone(augmented);

    expect(readCompatibleContract("pose2d", { ...expected, contract_version: "1.0.0" })).toEqual({
      ...expected,
      contract_version: "1.0.0",
    });
    expect(validateContract("pose2d", augmented)).toBe(false);
    expect(readCompatibleContract("pose2d", augmented)).toStrictEqual(expected);
    expect(augmented).toStrictEqual(original);
    expect(
      readCompatibleContract("pose2d", { ...augmented, contract_version: "2.0.0" }),
    ).toBeUndefined();
    expect(
      readCompatibleContract("pose2d", { ...augmented, contract_version: "1.09.0" }),
    ).toBeUndefined();
  });

  test("rejects invalid known fields and missing required fields", () => {
    const input = { ...pose2d, contract_version: "1.9.0", future_camera: "side-b" };
    expect(readCompatibleContract("pose2d", { ...input, unit: "m" })).toBeUndefined();
    expect(readCompatibleContract("pose2d", { ...input, view_id: undefined })).toBeUndefined();
    expect(
      readCompatibleContract("pose2d", {
        ...input,
        frames: input.frames.map((frame) => ({
          ...frame,
          landmarks: frame.landmarks.map((point) => ({ ...point, x: "wrong", future_weight: 1 })),
        })),
      }),
    ).toBeUndefined();
  });

  test("projects DLT view internals and rejects fields from a different calibration mode", () => {
    const expected = { ...dlt, contract_version: "1.9.0" };
    const augmented = {
      ...expected,
      views: dlt.views.map((view) => ({
        ...view,
        intrinsics: { ...view.intrinsics, sensor_mm: 10 },
      })),
    };
    expect(validateContract("calibration", augmented)).toBe(false);
    expect(readCompatibleContract("calibration", augmented)).toStrictEqual(expected);
    expect(
      readCompatibleContract("calibration", { ...augmented, fit_rms_px: 0.8 }),
    ).toBeUndefined();
  });

  test("projects through referenced schemas and conditional statistic fields", () => {
    const expected = { ...shareV1, contract_version: "1.9.0" };
    const augmented = {
      ...expected,
      evidence_comparisons: share.evidence_comparisons.map((comparison) => ({
        ...comparison,
        reference_values: { ...comparison.reference_values, future_std_error: 0.1 },
      })),
      kinematic_summary: {
        ...expected.kinematic_summary,
        provenance: {
          ...expected.kinematic_summary.provenance,
          stage_models: expected.kinematic_summary.provenance.stage_models.map((model) => ({
            ...model,
            future_license_url: "fixture",
          })),
        },
      },
    };
    expect(validateContract("share_report", augmented)).toBe(false);
    expect(readCompatibleContract("share_report", augmented)).toStrictEqual(expected);
    expect(
      readCompatibleContract("share_report", {
        ...augmented,
        kinematic_summary: {
          ...augmented.kinematic_summary,
          events: augmented.kinematic_summary.events.map((event) => ({
            ...event,
            side: undefined,
          })),
        },
      }),
    ).toBeUndefined();
    expect(
      readCompatibleContract("share_report", {
        ...augmented,
        kinematic_summary: { ...augmented.kinematic_summary, contract_version: "2.0.0" },
      }),
    ).toBeUndefined();
    expect(
      readCompatibleContract("share_report", {
        ...augmented,
        evidence_comparisons: augmented.evidence_comparisons.map((comparison) => ({
          ...comparison,
          reference_values: { ...comparison.reference_values, sd: -1 },
        })),
      }),
    ).toBeUndefined();
    expect(
      readCompatibleContract("share_report", {
        ...augmented,
        evidence_comparisons: augmented.evidence_comparisons.map((comparison) => ({
          ...comparison,
          reference_values: { ...comparison.reference_values, lower: 0 },
        })),
      }),
    ).toBeUndefined();
  });
});

describe("share report timestamp ordering", () => {
  test.each([
    ["2024-02-29t10:00:00z", "2024-03-01T00:00:00+13:00"],
    ["2026-11-20T02:30:00.123456789123Z", "2026-11-19T23:00:00.123456789124-03:30"],
    ["2026-11-20T02:30:00.000000000Z", "2026-11-20T04:30:00.000000001+02:00"],
    ["0099-01-01T00:00:00+23:59", "0099-01-01T00:00:00-23:59"],
  ])("accepts %s before %s", (issued_at, expires_at) => {
    expect(validateContract("share_report", { ...share, issued_at, expires_at })).toBe(true);
  });

  test.each([
    ["2026-11-20T02:30:00.1Z", "2026-11-20T04:30:00.100000000+02:00"],
    ["2026-11-20T02:30:00.123456789124Z", "2026-11-19T23:00:00.123456789123-03:30"],
    ["2026-11-20T02:30:00Z", "2026-11-20T03:30:00+02:00"],
  ])("rejects %s at or after %s", (issued_at, expires_at) => {
    expect(validateContract("share_report", { ...share, issued_at, expires_at })).toBe(false);
  });

  test.each([
    "2026-02-29T02:30:00Z",
    "2026-11-31T02:30:00Z",
    "0000-01-01T00:00:00Z",
    "2026-11-20T24:00:00Z",
    "2026-11-20T02:30:60Z",
    "2026-11-20T02:30:00+24:00",
    "2026-11-20T02:30:00+00:60",
    "2026-11-20T02:30:00",
    "2026-11-20T02:30:00Z\n",
  ])("rejects invalid timestamp %j", (issued_at) => {
    expect(validateContract("share_report", { ...share, issued_at })).toBe(false);
    expect(validateContract("evidence_catalog", { ...catalog, generated_at: issued_at })).toBe(
      false,
    );
  });
});
