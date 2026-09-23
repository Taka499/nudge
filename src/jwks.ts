/**
 * GitHub's OIDC key set, fetched once and cached per Worker isolate.
 *
 * The fetch function is an argument so tests can count calls; the clock is passed per call so
 * expiry is testable without waiting. A caller that meets an unknown `kid` asks for a refresh,
 * which is how a key rotation is picked up before the cache expires — but the key id is read
 * before any signature is checked, so anyone can ask for that refresh with a junk token. A
 * fetch is *attempted* at most once per `minRefreshMs` — failures count, so an outage at GitHub
 * cannot turn a request flood into a fetch flood — and concurrent callers share one in-flight
 * fetch. Inside that interval a stale key set is served if one exists; with none, the call fails
 * without fetching.
 */

import type { Fetcher } from "./fetcher.ts";
import { GITHUB_JWKS_URL, type JsonWebKeySet, type Jwk } from "./oidc.ts";

export type JwksSource = (now: Date, forceRefresh?: boolean) => Promise<JsonWebKeySet>;

export const JWKS_TTL_MS = 10 * 60 * 1000;
/** Shortest interval between two fetches, whatever callers ask for. */
export const JWKS_MIN_REFRESH_MS = 60 * 1000;

export interface JwksOptions {
  ttlMs?: number;
  minRefreshMs?: number;
  url?: string;
}

export function createJwksSource(fetcher: Fetcher, options: JwksOptions = {}): JwksSource {
  const { ttlMs = JWKS_TTL_MS, minRefreshMs = JWKS_MIN_REFRESH_MS, url = GITHUB_JWKS_URL } = options;
  let cached: { keys: JsonWebKeySet; fetchedAt: number } | undefined;
  let inFlight: Promise<JsonWebKeySet> | undefined;
  let lastAttemptAt: number | undefined;

  const fetchKeys = async (now: Date): Promise<JsonWebKeySet> => {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
    const keys = parseJwks(await response.json());
    cached = { keys, fetchedAt: now.getTime() };
    return keys;
  };

  return async (now, forceRefresh = false) => {
    if (cached && !forceRefresh && now.getTime() - cached.fetchedAt < ttlMs) return cached.keys;
    if (inFlight) return inFlight;
    if (lastAttemptAt !== undefined && now.getTime() - lastAttemptAt < minRefreshMs) {
      if (cached) return cached.keys;
      throw new Error("JWKS fetch failed recently; not retrying before the minimum interval");
    }
    lastAttemptAt = now.getTime();
    inFlight = fetchKeys(now).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
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
