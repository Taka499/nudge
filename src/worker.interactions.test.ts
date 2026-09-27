import { beforeAll, describe, expect, test } from "bun:test";
import { DISCORD_API } from "./discord.ts";
import { GITHUB_API } from "./github-app.ts";
import { componentInteraction } from "./interactions.test.ts";
import { createAppKey, jwtPayload, type AppKey } from "./testing/app-fixture.ts";
import { TIMESTAMP, createDiscordSigner, signInteraction, type DiscordSigner } from "./testing/discord-fixture.ts";
import { bodyText, requestUrl } from "./testing/http.ts";
import { AUDIENCE, NOW, SHA } from "./testing/oidc-fixture.ts";
import { MAX_BODY_BYTES, handle, type Deps, type Env } from "./worker.ts";

const REPO = "Taka499/ss-assist";
const MESSAGE_URL = `${DISCORD_API}/channels/123/messages/555`;

let signer: DiscordSigner;
let appKey: AppKey;
let env: Env;
beforeAll(async () => {
  signer = await createDiscordSigner();
  appKey = await createAppKey();
  env = {
    DISCORD_PUBLIC_KEY: signer.publicKeyHex,
    DISCORD_BOT_TOKEN: "bot-secret",
    DISCORD_CHANNEL_ID: "123",
    DISCORD_ALLOWED_USERS: "42, 43",
    GITHUB_APP_ID: "7",
    GITHUB_APP_PRIVATE_KEY: appKey.pkcs1Pem,
  };
});

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

interface World {
  deps: Deps;
  calls: Call[];
  /** Bodies of the PATCHes to the request message. */
  patches: unknown[];
  /** What the Worker handed to waitUntil; a test awaits it to see the dispatch through. */
  settled: Promise<unknown>[];
}

/** A fake Discord and GitHub. `/interactions` must never fetch anything else. */
function world(options: { installed?: boolean; dispatchStatus?: number; editStatus?: number } = {}): World {
  const w: World = { calls: [], patches: [], settled: [], deps: { fetch: async () => new Response(null), now: () => NOW, jwks: async () => ({ keys: [] }), sleep: async () => {}, waitUntil: () => undefined } };
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const body: unknown = bodyText(init) ? JSON.parse(bodyText(init)) : undefined;
    w.calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("Authorization"), body });
    if (url === MESSAGE_URL && init?.method === "PATCH") {
      w.patches.push(body);
      return options.editStatus === undefined ? Response.json({ id: "555" }) : new Response(null, { status: options.editStatus });
    }
    if (url === `${GITHUB_API}/repos/${REPO}/installation`) return options.installed === false ? new Response(null, { status: 404 }) : Response.json({ id: 42 });
    if (url === `${GITHUB_API}/app/installations/42/access_tokens`) return Response.json({ token: "ghs_x" }, { status: 201 });
    if (url === `${GITHUB_API}/repos/${REPO}/dispatches`) return new Response(null, { status: options.dispatchStatus ?? 204 });
    throw new Error(`unexpected fetch ${url}`);
  };
  w.deps = { fetch: fetcher, now: () => NOW, jwks: async () => ({ keys: [] }), sleep: async () => {}, waitUntil: (work) => { w.settled.push(work); } };
  return w;
}

function interaction(body: string, headers: Record<string, string>): Request {
  return new Request(`${AUDIENCE}/interactions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

async function signed(body: string): Promise<Request> {
  return interaction(body, { "X-Signature-Ed25519": await signInteraction(signer, body), "X-Signature-Timestamp": TIMESTAMP });
}

async function press(w: World, overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}, e: Env = env): Promise<unknown> {
  const response = await handle(await signed(JSON.stringify(componentInteraction(overrides, message))), e, w.deps);
  expect(response.status).toBe(200);
  return response.json();
}

describe("POST /interactions", () => {
  test("a signed PING is answered with a PONG", async () => {
    const response = await handle(await signed('{"type":1,"id":"1","application_id":"2"}'), env, world().deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ type: 1 });
  });

  test("an unsigned, mis-signed or tampered request is 401", async () => {
    const body = '{"type":1}';
    const signature = await signInteraction(signer, body);
    const cases = [
      interaction(body, {}),
      interaction(body, { "X-Signature-Ed25519": signature }),
      interaction(body, { "X-Signature-Timestamp": TIMESTAMP }),
      interaction(body, { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": "1790121601" }),
      interaction('{"type":1 }', { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": TIMESTAMP }),
      interaction(body, { "X-Signature-Ed25519": await signInteraction(await createDiscordSigner(), body), "X-Signature-Timestamp": TIMESTAMP }),
    ];
    for (const request of cases) {
      const response = await handle(request, env, world().deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid request signature" });
    }
  });

  test("a signed body that is neither a PING nor a button press is 400", async () => {
    expect((await handle(await signed('{"type":2}'), env, world().deps)).status).toBe(400);
    expect((await handle(await signed('{"type":3,"data":{"custom_id":"other"}}'), env, world().deps)).status).toBe(400);
    expect((await handle(await signed("{not json"), env, world().deps)).status).toBe(400);
    expect((await handle(await signed("[]"), env, world().deps)).status).toBe(400);
  });

  test("a request signed more than five minutes from now is 401: a captured request cannot be replayed later", async () => {
    const w = world();
    const body = JSON.stringify(componentInteraction());
    const late = { ...w.deps, now: () => new Date(NOW.getTime() + 5 * 60 * 1000 + 1000) };
    const response = await handle(await signed(body), env, late);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "stale request timestamp" });
    expect(w.settled).toHaveLength(0);
    const early = { ...w.deps, now: () => new Date(NOW.getTime() - 5 * 60 * 1000 - 1000) };
    expect((await handle(await signed('{"type":1}'), env, early)).status).toBe(401);
  });

  test("an instance with no DISCORD_PUBLIC_KEY is 500", async () => {
    expect((await handle(await signed('{"type":1}'), {}, world().deps)).status).toBe(500);
  });

  test("a body over the size limit is 413 before any signature work", async () => {
    expect((await handle(await signed(`{"type":1,"pad":"${"x".repeat(MAX_BODY_BYTES)}"}`), env, world().deps)).status).toBe(413);
  });

  test("GET is 405", async () => {
    expect((await handle(new Request(`${AUDIENCE}/interactions`), env, world().deps)).status).toBe(405);
  });
});

describe("a tap on Approve", () => {
  test("is acknowledged at once, then dispatches through the App and records it on the message", async () => {
    const w = world();
    expect(await press(w)).toEqual({ type: 6 });
    expect(w.settled).toHaveLength(1);
    await Promise.all(w.settled);
    expect(w.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${GITHUB_API}/repos/${REPO}/installation`],
      ["POST", `${GITHUB_API}/app/installations/42/access_tokens`],
      ["POST", `${GITHUB_API}/repos/${REPO}/dispatches`],
      ["PATCH", MESSAGE_URL],
    ]);
    expect(jwtPayload((w.calls[0]?.auth ?? "").replace("Bearer ", ""))).toMatchObject({ iss: "7" });
    expect(w.calls[2]).toMatchObject({ auth: "Bearer ghs_x", body: { event_type: "nudge-approved", client_payload: { id: "555", commit: SHA, actor: "42" } } });
    expect(w.patches[0]).toEqual({ content: `**${REPO}** — approved by <@42>, dispatched`, components: [], allowed_mentions: { parse: [] } });
  });

  test("whose recording edit fails lets the background work reject, so the runtime logs it", async () => {
    const w = world({ editStatus: 500 });
    expect(await press(w)).toEqual({ type: 6 });
    expect(await Promise.all(w.settled).then(() => "resolved", (e: unknown) => e)).toBeInstanceOf(Error);
    expect(w.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "PATCH"]);
  });

  test("twice within the same second dispatches twice: the accepted race of A21, which the consumer's guard tolerates", async () => {
    const w = world();
    expect(await press(w)).toEqual({ type: 6 });
    expect(await press(w)).toEqual({ type: 6 });
    await Promise.all(w.settled);
    expect(w.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(2);
  });

  test("whose dispatch fails keeps the buttons and says why", async () => {
    const w = world({ installed: false });
    expect(await press(w)).toEqual({ type: 6 });
    await Promise.all(w.settled);
    expect(w.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(w.patches[0]).toMatchObject({ content: `**${REPO}** — approve failed: the GitHub App is not installed on this repository; tap again to retry` });
    expect(w.patches[0]).not.toHaveProperty("components");
  });
});

describe("a tap on Decline", () => {
  test("removes the buttons at once, dispatches nudge-declined, and edits nothing more on success", async () => {
    const w = world();
    expect(await press(w, { data: { custom_id: `decline:${SHA}` } })).toEqual({
      type: 7,
      data: { content: `**${REPO}** — declined by <@42>`, components: [], allowed_mentions: { parse: [] } },
    });
    await Promise.all(w.settled);
    expect(w.calls[2]).toMatchObject({ body: { event_type: "nudge-declined", client_payload: { id: "555", commit: SHA, actor: "42" } } });
    expect(w.patches).toHaveLength(0);
  });

  test("whose dispatch fails notes that the repository was not told", async () => {
    const w = world({ dispatchStatus: 500 });
    await press(w, { data: { custom_id: `decline:${SHA}` } });
    await Promise.all(w.settled);
    expect(w.patches[0]).toMatchObject({ content: `**${REPO}** — declined by <@42>; the repository was not told: GitHub answered 500 at dispatch` });
  });
});

describe("a tap that is refused", () => {
  test("by someone not on the allowlist gets an ephemeral reply and nothing happens", async () => {
    const w = world();
    const answer = await press(w, { member: { user: { id: "99" } } });
    expect(answer).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(w.calls).toHaveLength(0);
    expect(w.settled).toHaveLength(0);
  });

  test("on a message already answered gets an ephemeral reply", async () => {
    const w = world();
    expect(await press(w, {}, { components: [] })).toMatchObject({ type: 4, data: { flags: 64, content: "This request has already been answered." } });
    expect(w.calls).toHaveLength(0);
  });

  test("on a message older than 7 days marks it expired and removes the buttons, without dispatching", async () => {
    const w = world();
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(await press(w, {}, { timestamp: old })).toEqual({
      type: 7,
      data: { content: `**${REPO}** — expired: not answered within 7 days`, components: [], allowed_mentions: { parse: [] } },
    });
    expect(w.calls).toHaveLength(0);
    expect(w.settled).toHaveLength(0);
  });

  test("in a channel other than the instance's gets an ephemeral reply and nothing happens", async () => {
    const w = world();
    expect(await press(w, { channel_id: "999" })).toMatchObject({ type: 4, data: { flags: 64, content: "This message is not in the channel this instance serves." } });
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(await press(w, { channel_id: "999" }, { timestamp: old })).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(w.calls).toHaveLength(0);
    expect(w.settled).toHaveLength(0);
  });

  test("on an instance without the GitHub App credentials is 500, after the allowlist", async () => {
    const w = world();
    const noApp = { ...env, GITHUB_APP_ID: undefined };
    expect((await handle(await signed(JSON.stringify(componentInteraction())), noApp, w.deps)).status).toBe(500);
    expect(w.settled).toHaveLength(0);
  });
});
