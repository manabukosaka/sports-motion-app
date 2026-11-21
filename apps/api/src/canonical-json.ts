import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : Number(left !== right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("JSON numbers must be finite");
  }
  if (value !== null && !["boolean", "number", "string"].includes(typeof value)) {
    throw new TypeError("Expected a JSON value");
  }
  return JSON.stringify(value);
}

export function jsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
