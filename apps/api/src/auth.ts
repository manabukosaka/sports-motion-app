import { createHmac, type KeyObject, timingSafeEqual } from "node:crypto";
import type { ApiOptions } from "./http.js";

export interface BearerTokenClaims {
  userId: string;
  issuer: string;
  audience: string;
  expiresAt: number;
  tokenId: string;
}

interface BearerOptions {
  secret: KeyObject;
  issuer: string;
  audience: string;
  revokedTokenIds?: ReadonlySet<string>;
}

function encode({ userId, issuer, audience, expiresAt, tokenId }: BearerTokenClaims) {
  return Buffer.from(JSON.stringify([userId, issuer, audience, expiresAt, tokenId])).toString(
    "base64url",
  );
}

function signature(payload: string, secret: KeyObject) {
  return createHmac("sha256", secret).update(`bearer-v1:${payload}`, "ascii").digest();
}

function validClaim(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireSecret(secret: KeyObject) {
  if (secret.type !== "secret" || (secret.symmetricKeySize ?? 0) < 32) {
    throw new TypeError("Bearer signing requires a secret key of at least 32 bytes");
  }
}

export function issueBearerToken(claims: BearerTokenClaims, secret: KeyObject) {
  requireSecret(secret);
  const { userId, issuer, audience, expiresAt, tokenId } = claims;
  if (
    !validClaim(userId) ||
    !validClaim(issuer) ||
    !validClaim(audience) ||
    !validClaim(tokenId) ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw new TypeError("Invalid bearer token claims");
  }
  const payload = encode(claims);
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function verifyBearerToken(
  headerValue: string | undefined,
  { secret, issuer, audience, now, revokedTokenIds }: BearerOptions & { now: number },
): BearerTokenClaims | undefined {
  requireSecret(secret);
  if (headerValue === undefined || headerValue.length > 8192 || !Number.isSafeInteger(now)) {
    return;
  }
  const [, payload, tag] =
    /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(headerValue) ?? [];
  if (!payload || !tag || headerValue !== `Bearer ${payload}.${tag}`) {
    return;
  }
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
  const [userId, tokenIssuer, tokenAudience, expiresAt, tokenId] = contents;
  if (
    !validClaim(userId) ||
    !validClaim(tokenIssuer) ||
    tokenIssuer !== issuer ||
    !validClaim(tokenAudience) ||
    tokenAudience !== audience ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    now >= expiresAt ||
    !validClaim(tokenId) ||
    revokedTokenIds?.has(tokenId)
  ) {
    return;
  }
  const claims = { userId, issuer: tokenIssuer, audience: tokenAudience, expiresAt, tokenId };
  return encode(claims) === payload ? claims : undefined;
}

export function createBearerAuthenticator({
  now = Date.now,
  ...options
}: BearerOptions & { now?: () => number }): ApiOptions["authenticate"] {
  requireSecret(options.secret);
  if (!validClaim(options.issuer) || !validClaim(options.audience)) {
    throw new TypeError("Bearer authenticator requires non-empty issuer and audience");
  }
  return ({ headersDistinct: { authorization } }) => {
    if (authorization?.length === 1) {
      return verifyBearerToken(authorization[0], { ...options, now: now() })?.userId;
    }
  };
}
