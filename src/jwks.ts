/**
 * GitHub's OIDC key set, fetched once and cached per Worker isolate.
 *
 * The fetch function is an argument so tests can count calls; the clock is passed per call so
 * expiry is testable without waiting. A caller that meets an unknown `kid` asks for a refresh
 * once, which is how a key rotation is picked up before the cache expires.
 */

import type { Fetcher } from "./fetcher.ts";
import { GITHUB_JWKS_URL, type JsonWebKeySet, type Jwk } from "./oidc.ts";

export type JwksSource = (now: Date, forceRefresh?: boolean) => Promise<JsonWebKeySet>;

export const JWKS_TTL_MS = 10 * 60 * 1000;

export function createJwksSource(fetcher: Fetcher, ttlMs = JWKS_TTL_MS, url = GITHUB_JWKS_URL): JwksSource {
  let cached: { keys: JsonWebKeySet; fetchedAt: number } | undefined;
  return async (now, forceRefresh = false) => {
    if (cached && !forceRefresh && now.getTime() - cached.fetchedAt < ttlMs) return cached.keys;
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
    const keys = parseJwks(await response.json());
    cached = { keys, fetchedAt: now.getTime() };
    return keys;
  };
}

export function parseJwks(raw: unknown): JsonWebKeySet {
  if (typeof raw !== "object" || raw === null || !("keys" in raw) || !Array.isArray(raw.keys)) {
    throw new Error("JWKS response has no keys array");
  }
  return { keys: raw.keys.filter(isJwk) };
}

function isJwk(value: unknown): value is Jwk {
  return typeof value === "object" && value !== null && "kty" in value && typeof value.kty === "string";
}
