import { beforeAll, describe, expect, test } from "bun:test";
import { JWKS_MIN_REFRESH_MS, createJwksSource } from "./jwks.ts";
import { GITHUB_JWKS_URL, type JsonWebKeySet } from "./oidc.ts";
import { DISCORD_API } from "./discord.ts";
import { bodyText, requestUrl } from "./testing/http.ts";
import { AUDIENCE, NOW, createSigner, mint, standardClaims, type Signer } from "./testing/oidc-fixture.ts";
import { MAX_BODY_BYTES, bearerToken, handle, type Deps, type Env } from "./worker.ts";

const CHANNEL_MESSAGES = `${DISCORD_API}/channels/123/messages`;
const ENV: Env = { ALLOWED_OWNERS: "Taka499, tia-tools", DISCORD_BOT_TOKEN: "bot-secret", DISCORD_CHANNEL_ID: "123" };

let signer: Signer;
beforeAll(async () => {
  signer = await createSigner();
});

interface World {
  deps: Deps;
  jwksFetches: number;
  posted: unknown[];
  /** Milliseconds the Worker asked to wait (the one retry on a Discord 429). */
  slept: number[];
  /** The Authorization header of the last Discord post. */
  authorization: string | null;
  /** Milliseconds added to NOW; tests move the clock by changing it. */
  elapsedMs: number;
}

function world(options: { jwks?: () => JsonWebKeySet; discordStatus?: number; discordBody?: unknown; discordFirstAnswer?: Response } = {}): World {
  const sleep = async (ms: number): Promise<void> => { w.slept.push(ms); };
  const w: World = { jwksFetches: 0, posted: [], authorization: null, slept: [], elapsedMs: 0, deps: { fetch: async () => new Response(null), now: () => NOW, jwks: async () => ({ keys: [] }), sleep } };
  let firstAnswer = options.discordFirstAnswer;
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === GITHUB_JWKS_URL) {
      w.jwksFetches += 1;
      return Response.json((options.jwks ?? (() => signer.jwks))());
    }
    if (url === CHANNEL_MESSAGES) {
      w.posted.push(JSON.parse(bodyText(init)));
      w.authorization = new Headers(init?.headers).get("Authorization");
      if (firstAnswer) { const answer = firstAnswer; firstAnswer = undefined; return answer; }
      return options.discordStatus === undefined ? Response.json(options.discordBody ?? { id: "555" }) : new Response(null, { status: options.discordStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  w.deps = { fetch: fetcher, now: () => new Date(NOW.getTime() + w.elapsedMs), jwks: createJwksSource(fetcher), sleep };
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
    expect(w.authorization).toBe("Bot bot-secret");
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

  test("an unconfigured instance is 500 and a refusing Discord is 502", async () => {
    const token = await mint(signer);
    expect((await handle(post(token, INPUT), { ...ENV, DISCORD_BOT_TOKEN: undefined }, world().deps)).status).toBe(500);
    expect((await handle(post(token, INPUT), { ...ENV, DISCORD_CHANNEL_ID: undefined }, world().deps)).status).toBe(500);
    const w = world({ discordStatus: 400 });
    expect((await handle(post(token, INPUT), ENV, w.deps)).status).toBe(502);
    expect(w.posted).toHaveLength(1);
    const idless = world({ discordBody: { ok: true } });
    const response = await handle(post(token, INPUT), ENV, idless.deps);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("Discord refused the message");
  });

  test("a rate-limited Discord is retried once after the wait it asks for", async () => {
    const token = await mint(signer);
    const w = world({ discordFirstAnswer: new Response(null, { status: 429, headers: { "Retry-After": "1" } }) });
    expect((await handle(post(token, INPUT), ENV, w.deps)).status).toBe(204);
    expect(w.posted).toHaveLength(2);
    expect(w.slept).toEqual([1000]);
    const far = world({ discordFirstAnswer: new Response(null, { status: 429, headers: { "Retry-After": "30" } }) });
    expect((await handle(post(token, INPUT), ENV, far.deps)).status).toBe(502);
    expect(far.posted).toHaveLength(1);
    expect(far.slept).toEqual([]);
    const thenRefused = world({ discordFirstAnswer: new Response(null, { status: 429, headers: { "Retry-After": "0" } }), discordStatus: 400 });
    expect((await handle(post(token, INPUT), ENV, thenRefused.deps)).status).toBe(502);
    expect(thenRefused.posted).toHaveLength(2);
    expect(thenRefused.slept).toEqual([0]);
  });

  test("a rotated key is picked up by a refresh once the minimum interval has passed", async () => {
    const rotated = await createSigner("rotated");
    let served = 0;
    const w = world({ jwks: () => (served++ === 0 ? signer.jwks : { keys: [...signer.jwks.keys, ...rotated.jwks.keys] }) });
    expect((await handle(post(await mint(signer), INPUT), ENV, w.deps)).status).toBe(204);
    expect(w.jwksFetches).toBe(1);
    w.elapsedMs = JWKS_MIN_REFRESH_MS;
    expect((await handle(post(await mint(rotated), INPUT), ENV, w.deps)).status).toBe(204);
    expect(w.jwksFetches).toBe(2);
  });

  test("a flood of tokens with unknown key ids cannot force more than one fetch per interval", async () => {
    const w = world();
    expect((await handle(post(await mint(signer), INPUT), ENV, w.deps)).status).toBe(204);
    const stranger = await createSigner("never-published");
    const forged = await mint(stranger);
    const junk = `${forged.split(".").slice(0, 2).join(".")}.AAAA`;
    for (let i = 0; i < 30; i += 1) {
      const response = await handle(post(i % 2 === 0 ? forged : junk, INPUT), ENV, w.deps);
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toBe("unknown key");
    }
    expect(w.jwksFetches).toBe(1);
    w.elapsedMs = JWKS_MIN_REFRESH_MS;
    for (let i = 0; i < 30; i += 1) expect((await handle(post(forged, INPUT), ENV, w.deps)).status).toBe(401);
    expect(w.jwksFetches).toBe(2);
    expect(w.posted).toHaveLength(1);
  });

  test("an unreachable JWKS endpoint is 503", async () => {
    const deps: Deps = { fetch: async () => new Response(null), now: () => NOW, jwks: async () => { throw new Error("down"); }, sleep: async () => {} };
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
