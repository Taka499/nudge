import { describe, expect, test } from "bun:test";
import { JWKS_MIN_REFRESH_MS, JWKS_TTL_MS, createJwksSource, parseJwks } from "./jwks.ts";
import { requestUrl } from "./testing/http.ts";

function fakeFetch(bodies: unknown[], status = 200): { fetcher: (input: string | URL | Request) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetcher: async (input) => {
      calls.push(requestUrl(input));
      const body = bodies[Math.min(calls.length, bodies.length) - 1];
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

const t0 = new Date("2026-09-23T00:00:00Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const set = (kid: string): unknown => ({ keys: [{ kty: "RSA", kid }] });

describe("createJwksSource", () => {
  test("fetches once and serves from cache within the TTL", async () => {
    const { fetcher, calls } = fakeFetch([set("a")]);
    const jwks = createJwksSource(fetcher, { url: "https://keys.test/jwks" });
    expect(await jwks(t0)).toEqual({ keys: [{ kty: "RSA", kid: "a" }] });
    await jwks(at(JWKS_TTL_MS - 1));
    expect(calls).toEqual(["https://keys.test/jwks"]);
  });

  test("refetches when the TTL has elapsed", async () => {
    const { fetcher, calls } = fakeFetch([set("a"), set("b")]);
    const jwks = createJwksSource(fetcher);
    await jwks(t0);
    expect((await jwks(at(JWKS_TTL_MS))).keys[0]?.kid).toBe("b");
    expect(calls).toHaveLength(2);
  });

  test("a forced refresh bypasses the cache once the minimum interval has passed", async () => {
    const { fetcher, calls } = fakeFetch([set("a"), set("b")]);
    const jwks = createJwksSource(fetcher);
    await jwks(t0);
    expect((await jwks(at(JWKS_MIN_REFRESH_MS), true)).keys[0]?.kid).toBe("b");
    expect(calls).toHaveLength(2);
  });

  test("forced refreshes inside the minimum interval are served from cache", async () => {
    const { fetcher, calls } = fakeFetch([set("a"), set("b")]);
    const jwks = createJwksSource(fetcher);
    await jwks(t0);
    for (let i = 0; i < 50; i += 1) expect((await jwks(at(JWKS_MIN_REFRESH_MS - 1), true)).keys[0]?.kid).toBe("a");
    expect(calls).toHaveLength(1);
  });

  test("concurrent callers share one in-flight fetch", async () => {
    const { fetcher, calls } = fakeFetch([set("a")]);
    const jwks = createJwksSource(fetcher);
    const results = await Promise.all(Array.from({ length: 20 }, () => jwks(t0, true)));
    expect(results.every((r) => r.keys[0]?.kid === "a")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("a failed fetch is not retried before the minimum interval, then is", async () => {
    const { fetcher, calls } = fakeFetch([{}], 503);
    const jwks = createJwksSource(fetcher);
    const first = await jwks(t0).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    if (first instanceof Error) expect(first.message).toBe("JWKS fetch failed: 503");
    for (let i = 0; i < 20; i += 1) {
      const again = await jwks(at(JWKS_MIN_REFRESH_MS - 1), true).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(Error);
    }
    expect(calls).toHaveLength(1);
    await jwks(at(JWKS_MIN_REFRESH_MS)).catch(() => undefined);
    expect(calls).toHaveLength(2);
  });

  test("when a refresh of an expired cache fails, the stale keys are served until the next attempt", async () => {
    let status = 200;
    const calls: string[] = [];
    const jwks = createJwksSource(async (input) => {
      calls.push(requestUrl(input));
      return new Response(JSON.stringify(set("a")), { status });
    });
    await jwks(t0);
    status = 503;
    const failed = await jwks(at(JWKS_TTL_MS)).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    for (let i = 0; i < 20; i += 1) expect((await jwks(at(JWKS_TTL_MS + 1), true)).keys[0]?.kid).toBe("a");
    expect(calls).toHaveLength(2);
    status = 200;
    await jwks(at(JWKS_TTL_MS + JWKS_MIN_REFRESH_MS));
    expect(calls).toHaveLength(3);
  });
});

describe("parseJwks", () => {
  test("keeps only entries that look like keys", () => {
    expect(parseJwks({ keys: [{ kty: "RSA", kid: "a" }, { nope: 1 }, null, "x"] })).toEqual({ keys: [{ kty: "RSA", kid: "a" }] });
    expect(parseJwks({ keys: [] })).toEqual({ keys: [] });
  });

  test("anything without a keys array is an error", () => {
    for (const raw of [null, undefined, "", 42, {}, { keys: "RSA" }, { keys: null }, []]) {
      expect(() => parseJwks(raw)).toThrow("JWKS response has no keys array");
    }
  });
});
