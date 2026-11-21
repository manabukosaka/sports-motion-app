import { createHmac, type KeyObject, timingSafeEqual } from "node:crypto";

export interface ShareTokenClaims {
  shareLinkId: string;
  teamId: string;
  analysisRevisionId: string;
  evidenceSnapshotId: string;
  expiresAt: number;
}

function encode(claims: ShareTokenClaims) {
  return Buffer.from(
    JSON.stringify([
      claims.shareLinkId,
      claims.teamId,
      claims.analysisRevisionId,
      claims.evidenceSnapshotId,
      claims.expiresAt,
    ]),
  ).toString("base64url");
}

function signature(payload: string, secret: KeyObject) {
  return createHmac("sha256", secret).update(payload, "ascii").digest();
}

export function signShareToken(claims: ShareTokenClaims, secret: KeyObject) {
  const payload = encode(claims);
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifyShareToken(token: string, secret: KeyObject): ShareTokenClaims | undefined {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) {
    return;
  }
  const separator = token.indexOf(".");
  const payload = token.slice(0, separator);
  const tag = token.slice(separator + 1);
  const supplied = Buffer.from(tag, "base64url");
  if (
    supplied.toString("base64url") !== tag ||
    !timingSafeEqual(supplied, signature(payload, secret))
  ) {
    return;
  }
  let contents: unknown;
  try {
    contents = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(contents) || contents.length !== 5) {
    return;
  }
  const [shareLinkId, teamId, analysisRevisionId, evidenceSnapshotId, expiresAt] = contents;
  if (
    typeof shareLinkId !== "string" ||
    !shareLinkId ||
    typeof teamId !== "string" ||
    !teamId ||
    typeof analysisRevisionId !== "string" ||
    !analysisRevisionId ||
    typeof evidenceSnapshotId !== "string" ||
    !evidenceSnapshotId ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return;
  }
  const claims = { shareLinkId, teamId, analysisRevisionId, evidenceSnapshotId, expiresAt };
  return encode(claims) === payload ? claims : undefined;
}
