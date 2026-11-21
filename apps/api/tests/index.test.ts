import { expect, test } from "vitest";
import { contractHealth } from "../src/index.js";

test("reports the supported contract version", () => {
  expect(contractHealth()).toEqual({ status: "ok", contract_version: "1.0.0" });
});
