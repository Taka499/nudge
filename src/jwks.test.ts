import { describe, expect, test } from "bun:test";
import { JWKS_TTL_MS, createJwksSource, parseJwks } from "./jwks.ts";
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
    const jwks = createJwksSource(fetcher, JWKS_TTL_MS, "https://keys.test/jwks");
    expect(await jwks(t0)).toEqual({ keys: [{ kty: "RSA", kid: "a" }] });
    await jwks(at(JWKS_TTL_MS - 1));
    expect(calls).toEqual(["https://keys.test/jwks"]);
  });

  test("refetches when the TTL has elapsed", async () => {
    const { fetcher, calls } = fakeFetch([set("a"), set("b")]);
    const jwks = createJwksSource(fetcher, JWKS_TTL_MS);
    await jwks(t0);
    expect((await jwks(at(JWKS_TTL_MS))).keys[0]?.kid).toBe("b");
    expect(calls).toHaveLength(2);
  });

  test("a forced refresh bypasses a fresh cache", async () => {
    const { fetcher, calls } = fakeFetch([set("a"), set("b")]);
    const jwks = createJwksSource(fetcher);
    await jwks(t0);
    expect((await jwks(t0, true)).keys[0]?.kid).toBe("b");
    expect(calls).toHaveLength(2);
  });

  test("an error response throws and leaves nothing cached", async () => {
    const { fetcher, calls } = fakeFetch([{}], 503);
    const jwks = createJwksSource(fetcher);
    const first = await jwks(t0).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    if (first instanceof Error) expect(first.message).toBe("JWKS fetch failed: 503");
    const second = await jwks(t0).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(Error);
    expect(calls).toHaveLength(2);
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
