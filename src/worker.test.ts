import { beforeAll, describe, expect, test } from "bun:test";
import { createJwksSource } from "./jwks.ts";
import { GITHUB_JWKS_URL, type JsonWebKeySet } from "./oidc.ts";
import { bodyText, requestUrl } from "./testing/http.ts";
import { AUDIENCE, NOW, createSigner, mint, standardClaims, type Signer } from "./testing/oidc-fixture.ts";
import { MAX_BODY_BYTES, bearerToken, handle, type Deps, type Env } from "./worker.ts";

const WEBHOOK = "https://discord.test/api/webhooks/1/abc";
const ENV: Env = { ALLOWED_OWNERS: "Taka499, tia-tools", DISCORD_WEBHOOK_URL: WEBHOOK };

let signer: Signer;
beforeAll(async () => {
  signer = await createSigner();
});

interface World {
  deps: Deps;
  jwksFetches: number;
  posted: unknown[];
}

function world(options: { jwks?: () => JsonWebKeySet; webhookStatus?: number } = {}): World {
  const w: World = { jwksFetches: 0, posted: [], deps: { fetch: async () => new Response(null), now: () => NOW, jwks: async () => ({ keys: [] }) } };
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === GITHUB_JWKS_URL) {
      w.jwksFetches += 1;
      return Response.json((options.jwks ?? (() => signer.jwks))());
    }
    if (url === WEBHOOK) {
      w.posted.push(JSON.parse(bodyText(init)));
      return new Response(null, { status: options.webhookStatus ?? 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  w.deps = { fetch: fetcher, now: () => NOW, jwks: createJwksSource(fetcher) };
  return w;
}

/** `contentType: ""` sends no Content-Type header at all. */
function post(token: string | undefined, body: unknown, extra: { url?: string; contentType?: string; raw?: string } = {}): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  if (extra.contentType !== "") headers.set("Content-Type", extra.contentType ?? "application/json");
  return new Request(extra.url ?? `${AUDIENCE}/notify`, { method: "POST", headers, body: extra.raw ?? JSON.stringify(body) });
}

const INPUT = { title: "Weekly update", body: "all good" };

async function errorOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
}

describe("POST /notify", () => {
  test("a valid request posts to Discord and answers 204", async () => {
    const w = world();
    const response = await handle(post(await mint(signer), INPUT), ENV, w.deps);
    expect(response.status).toBe(204);
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ content: "**Taka499/nudge**", embeds: [{ title: "Weekly update", description: "all good" }] });
  });

  test("the audience is the instance's own origin unless NUDGE_AUDIENCE overrides it", async () => {
    const w = world();
    const token = await mint(signer);
    expect((await handle(post(token, INPUT, { url: "https://other.example.test/notify" }), ENV, w.deps)).status).toBe(401);
    expect((await handle(post(token, INPUT, { url: "https://other.example.test/notify" }), { ...ENV, NUDGE_AUDIENCE: AUDIENCE }, w.deps)).status).toBe(204);
    expect((await handle(post(token, INPUT), { ...ENV, NUDGE_AUDIENCE: "https://elsewhere.test" }, w.deps)).status).toBe(401);
    expect(w.posted).toHaveLength(1);
  });

  test("no token, an expired token and a foreign audience are 401 and post nothing", async () => {
    const w = world();
    const cases: [Request, string][] = [
      [post(undefined, INPUT), "missing bearer token"],
      [post(await mint(signer, standardClaims({ exp: 1 })), INPUT), "token expired"],
      [post(await mint(signer, standardClaims({ aud: "https://nudge.tia.run" })), INPUT), "wrong audience"],
      [post("garbage", INPUT), "malformed token"],
    ];
    for (const [request, reason] of cases) {
      const response = await handle(request, ENV, w.deps);
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toBe(reason);
    }
    const basic = new Request(`${AUDIENCE}/notify`, { method: "POST", headers: { Authorization: "Basic abc", "Content-Type": "application/json" }, body: "{}" });
    expect((await handle(basic, ENV, w.deps)).status).toBe(401);
    expect(w.posted).toHaveLength(0);
  });

  test("a repository outside ALLOWED_OWNERS is 403 and posts nothing", async () => {
    const w = world();
    const token = await mint(signer, standardClaims({ repository: "someone/else", repository_owner: "someone" }));
    const response = await handle(post(token, INPUT), ENV, w.deps);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toContain("someone");
    expect((await handle(post(await mint(signer), INPUT), { ...ENV, ALLOWED_OWNERS: undefined }, w.deps)).status).toBe(403);
    expect(w.posted).toHaveLength(0);
  });

  test("a bad body is 400, 413 or 415 and posts nothing", async () => {
    const w = world();
    const token = await mint(signer);
    expect((await handle(post(token, { title: "t" }), ENV, w.deps)).status).toBe(400);
    expect((await handle(post(token, undefined, { raw: "{not json" }), ENV, w.deps)).status).toBe(400);
    expect((await handle(post(token, INPUT, { contentType: "text/plain" }), ENV, w.deps)).status).toBe(415);
    expect((await handle(post(token, INPUT, { contentType: "" }), ENV, w.deps)).status).toBe(415);
    expect((await handle(post(token, { ...INPUT, body: "x".repeat(MAX_BODY_BYTES) }), ENV, w.deps)).status).toBe(413);
    expect((await handle(post(token, INPUT, { contentType: "application/json; charset=utf-8" }), ENV, w.deps)).status).toBe(204);
    expect(w.posted).toHaveLength(1);
  });

  test("an unconfigured instance is 500 and a refusing webhook is 502", async () => {
    const token = await mint(signer);
    expect((await handle(post(token, INPUT), { ...ENV, DISCORD_WEBHOOK_URL: undefined }, world().deps)).status).toBe(500);
    const w = world({ webhookStatus: 400 });
    expect((await handle(post(token, INPUT), ENV, w.deps)).status).toBe(502);
    expect(w.posted).toHaveLength(1);
  });

  test("an unknown key triggers exactly one JWKS refresh", async () => {
    const rotated = await createSigner("rotated");
    let served = 0;
    const w = world({ jwks: () => (served++ === 0 ? signer.jwks : { keys: [...signer.jwks.keys, ...rotated.jwks.keys] }) });
    expect((await handle(post(await mint(signer), INPUT), ENV, w.deps)).status).toBe(204);
    expect(w.jwksFetches).toBe(1);
    expect((await handle(post(await mint(rotated), INPUT), ENV, w.deps)).status).toBe(204);
    expect(w.jwksFetches).toBe(2);
    const unknown = await createSigner("never-published");
    const response = await handle(post(await mint(unknown), INPUT), ENV, w.deps);
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe("unknown key");
    expect(w.jwksFetches).toBe(3);
  });

  test("an unreachable JWKS endpoint is 503", async () => {
    const deps: Deps = { fetch: async () => new Response(null), now: () => NOW, jwks: async () => { throw new Error("down"); } };
    expect((await handle(post(await mint(signer), INPUT), ENV, deps)).status).toBe(503);
  });
});

describe("routing", () => {
  test("other paths are 404 and other methods are 405", async () => {
    const w = world();
    expect((await handle(new Request(`${AUDIENCE}/`), ENV, w.deps)).status).toBe(404);
    expect((await handle(new Request(`${AUDIENCE}/request`, { method: "POST" }), ENV, w.deps)).status).toBe(404);
    const get = await handle(new Request(`${AUDIENCE}/notify`), ENV, w.deps);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
  });
});

describe("bearerToken", () => {
  test("extracts the token case-insensitively and rejects other schemes", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer   x")).toBe("x");
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
  });
});
