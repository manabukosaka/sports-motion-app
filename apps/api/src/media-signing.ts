import { createHmac, type KeyObject, timingSafeEqual } from "node:crypto";

export type MediaMethod = "GET" | "PUT";

export interface MediaUrlClaims {
  teamId: string;
  trialId: string;
  objectKey: string;
  method: MediaMethod;
  expiresAt: number;
}

const scopeMarker = "trial-media";

export function isMediaSegment(segment: unknown): segment is string {
  return (
    typeof segment === "string" &&
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !/[/\\%\p{Cc}\p{Cs}]/u.test(segment)
  );
}

export function isMediaObjectKey(key: unknown): key is string {
  return typeof key === "string" && key.split("/").every(isMediaSegment);
}

function requireSecret(secret: KeyObject) {
  if (secret.type !== "secret" || (secret.symmetricKeySize ?? 0) < 32) {
    throw new TypeError("Media URL signing requires a secret key of at least 32 bytes");
  }
}

function decodePath(path: string): string[] | undefined {
  try {
    const segments = path.slice(1).split("/").map(decodeURIComponent);
    if (
      segments.every(isMediaSegment) &&
      `/${segments.map(encodeURIComponent).join("/")}` === path
    ) {
      return segments;
    }
  } catch {
    return;
  }
}

function absoluteTarget(url: string) {
  const [, authority, target] = /^(https?:\/\/[^/?#]+)(\/.*)?$/u.exec(url) ?? [];
  if (!authority || /[\\\s\p{Cc}]/u.test(url)) {
    return;
  }
  try {
    const { origin, username, password } = new URL(authority);
    if (!username && !password) {
      return { origin, target: target ?? "/" };
    }
  } catch {
    return;
  }
}

function signature(path: string, method: MediaMethod, expiresAt: number, secret: KeyObject) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(["media-url-v1", path, method, expiresAt]))
    .digest();
}

export function signMediaUrl(
  { baseUrl, teamId, trialId, objectKey, method, expiresAt }: MediaUrlClaims & { baseUrl: string },
  secret: KeyObject,
) {
  requireSecret(secret);
  const base = absoluteTarget(baseUrl);
  const prefix = base?.target.replace(/\/$/u, "");
  const baseSegments = prefix === "" ? [] : prefix && decodePath(prefix);
  if (
    !base ||
    !baseSegments ||
    baseSegments.includes(scopeMarker) ||
    !isMediaSegment(teamId) ||
    !isMediaSegment(trialId) ||
    !isMediaObjectKey(objectKey) ||
    (method !== "GET" && method !== "PUT") ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw new TypeError("Invalid media URL parameters");
  }
  const path = `/${[...baseSegments, scopeMarker, teamId, trialId, ...objectKey.split("/")].map(encodeURIComponent).join("/")}`;
  const tag = signature(path, method, expiresAt, secret).toString("base64url");
  return `${base.origin}${path}?expires_at=${expiresAt}&sig=${tag}`;
}

export function verifyMediaUrl(
  urlOrPath: string,
  { method, now, secret }: { method: MediaMethod; now: number; secret: KeyObject },
): MediaUrlClaims | undefined {
  requireSecret(secret);
  if (
    urlOrPath.length > 8192 ||
    (method !== "GET" && method !== "PUT") ||
    !Number.isSafeInteger(now)
  ) {
    return;
  }
  const target = urlOrPath.startsWith("/") ? urlOrPath : absoluteTarget(urlOrPath)?.target;
  const [, path, expiration, tag] =
    /^(\/[^?#]+)\?expires_at=(-?\d+)&sig=([A-Za-z0-9_-]{43})$/u.exec(target ?? "") ?? [];
  if (!path || !expiration || !tag || target !== `${path}?expires_at=${expiration}&sig=${tag}`) {
    return;
  }
  const expiresAt = Number(expiration);
  const segments = decodePath(path);
  const marker = segments?.indexOf(scopeMarker) ?? -1;
  if (
    !segments ||
    marker < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    String(expiresAt) !== expiration ||
    now >= expiresAt
  ) {
    return;
  }
  const supplied = Buffer.from(tag, "base64url");
  if (
    supplied.toString("base64url") !== tag ||
    !timingSafeEqual(supplied, signature(path, method, expiresAt, secret))
  ) {
    return;
  }
  const [teamId, trialId, ...keyParts] = segments.slice(marker + 1);
  if (teamId && trialId && keyParts.length > 0) {
    return { teamId, trialId, objectKey: keyParts.join("/"), method, expiresAt };
  }
}
