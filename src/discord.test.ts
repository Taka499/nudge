import { describe, expect, test } from "bun:test";
import { DISCORD_API, DiscordError, EMBED_LIMITS, MAX_RETRY_AFTER_MS, notifyMessage, postMessage, retryDelayMs, retryingOnRateLimit, shortRef, truncate } from "./discord.ts";
import type { WorkflowIdentity } from "./oidc.ts";
import { bodyText, requestUrl } from "./testing/http.ts";
import { NOW, SHA } from "./testing/oidc-fixture.ts";

const identity: WorkflowIdentity = {
  repository: "tia-tools/gakumas-supportcards",
  owner: "tia-tools",
  sha: SHA,
  ref: "refs/heads/main",
  runId: "987",
  runUrl: "https://github.com/tia-tools/gakumas-supportcards/actions/runs/987",
};

describe("notifyMessage", () => {
  test("starts with the repository and links the run by default", () => {
    const message = notifyMessage(identity, { title: "Weekly update merged", body: "12 cards changed" }, NOW);
    expect(message).toEqual({
      content: "**tia-tools/gakumas-supportcards**",
      embeds: [
        {
          title: "Weekly update merged",
          description: "12 cards changed",
          url: identity.runUrl,
          footer: { text: "main · 0123456 · run 987" },
          timestamp: "2026-09-23T00:00:00.000Z",
        },
      ],
      allowed_mentions: { parse: [] },
    });
  });

  test("a given url replaces the run link", () => {
    const message = notifyMessage(identity, { title: "t", body: "b", url: "https://github.com/x/y/pull/3" }, NOW);
    expect(message.embeds[0]?.url).toBe("https://github.com/x/y/pull/3");
  });

  test("long title and body are cut to Discord's limits", () => {
    const message = notifyMessage(identity, { title: "T".repeat(300), body: "B".repeat(5000) }, NOW);
    expect(message.embeds[0]?.title).toHaveLength(EMBED_LIMITS.title);
    expect(message.embeds[0]?.title.endsWith("…")).toBe(true);
    expect(message.embeds[0]?.description).toHaveLength(EMBED_LIMITS.description);
  });

  test("mentions in the body never ping", () => {
    const message = notifyMessage(identity, { title: "t", body: "@everyone look" }, NOW);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds[0]?.description).toBe("@everyone look");
  });
});

describe("truncate", () => {
  test("is exact at the boundary and counts characters, not bytes", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
    expect(truncate("", 3)).toBe("");
    expect(truncate("日本語です", 4)).toBe("日本語…");
    expect(truncate("ab", 1)).toBe("…");
    expect(truncate("ab", 0)).toBe("…");
  });
});

describe("shortRef", () => {
  test("strips branch and tag prefixes only", () => {
    expect(shortRef("refs/heads/main")).toBe("main");
    expect(shortRef("refs/heads/feature/x")).toBe("feature/x");
    expect(shortRef("refs/tags/v1")).toBe("v1");
    expect(shortRef("refs/pull/7/merge")).toBe("refs/pull/7/merge");
    expect(shortRef("")).toBe("");
  });
});

describe("postMessage", () => {
  const message = notifyMessage(identity, { title: "t", body: "b" }, NOW);
  const bot = { token: "bot-secret", channelId: "123" };
  const noSleep = async (): Promise<void> => {};

  test("posts the message as JSON into the channel with the bot token, and returns the message id", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const id = await postMessage(bot, message, async (url, init) => {
      seen.push({ url: requestUrl(url), init });
      return Response.json({ id: "555", content: "..." });
    }, noSleep);
    expect(id).toBe("555");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${DISCORD_API}/channels/123/messages`);
    expect(seen[0]?.init?.method).toBe("POST");
    expect(new Headers(seen[0]?.init?.headers).get("Authorization")).toBe("Bot bot-secret");
    expect(new Headers(seen[0]?.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(bodyText(seen[0]?.init))).toEqual(message);
  });

  test("a non-2xx answer throws with the status; a 2xx without a message id throws too", async () => {
    const failing = async (): Promise<Response> => new Response("rate limited", { status: 429 });
    const error = await postMessage(bot, message, failing, noSleep).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordError);
    if (error instanceof DiscordError) expect(error.status).toBe(429);
    const idless = async (): Promise<Response> => Response.json({ ok: true });
    expect(await postMessage(bot, message, idless, noSleep).catch((e: unknown) => e)).toBeInstanceOf(DiscordError);
  });
});

describe("retry on 429", () => {
  const limited = (retryAfter?: string): Response =>
    new Response("slow down", { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });

  test("retryDelayMs honours Retry-After in seconds up to the cap, and nothing else", () => {
    expect(retryDelayMs(limited("2"))).toBe(2000);
    expect(retryDelayMs(limited("0.25"))).toBe(250);
    expect(retryDelayMs(limited("0"))).toBe(0);
    expect(retryDelayMs(limited(String(MAX_RETRY_AFTER_MS / 1000)))).toBe(MAX_RETRY_AFTER_MS);
    expect(retryDelayMs(limited("6"))).toBeUndefined();
    expect(retryDelayMs(limited())).toBeUndefined();
    expect(retryDelayMs(limited("soon"))).toBeUndefined();
    expect(retryDelayMs(limited("-1"))).toBeUndefined();
    expect(retryDelayMs(limited(""))).toBeUndefined();
    expect(retryDelayMs(limited(" "))).toBeUndefined();
    expect(retryDelayMs(limited("0x1"))).toBeUndefined();
    expect(retryDelayMs(limited("1e3"))).toBeUndefined();
    expect(retryDelayMs(new Response(null, { status: 503, headers: { "Retry-After": "1" } }))).toBeUndefined();
    expect(retryDelayMs(new Response(null, { status: 200 }))).toBeUndefined();
  });

  test("retries exactly once after sleeping the requested time, and gives up on a second 429", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => { slept.push(ms); };
    let calls = 0;
    const answers = [limited("1"), Response.json({ id: "9" })];
    const fetcher = retryingOnRateLimit(async () => answers[calls++] ?? limited("1"), sleep);
    expect((await fetcher("https://discord.test")).status).toBe(200);
    expect(slept).toEqual([1000]);
    expect(calls).toBe(2);
    let alwaysCalls = 0;
    const always = retryingOnRateLimit(async () => { alwaysCalls += 1; return limited("1"); }, sleep);
    expect((await always("https://discord.test")).status).toBe(429);
    expect(slept).toEqual([1000, 1000]);
    expect(alwaysCalls).toBe(2);
  });

  test("a 429 beyond the cap or without Retry-After is returned at once, without sleeping", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => { slept.push(ms); };
    expect((await retryingOnRateLimit(async () => limited("60"), sleep)("https://discord.test")).status).toBe(429);
    expect((await retryingOnRateLimit(async () => limited(), sleep)("https://discord.test")).status).toBe(429);
    expect(slept).toEqual([]);
  });

  test("postMessage succeeds on the retry", async () => {
    const bot = { token: "bot-secret", channelId: "123" };
    const message = notifyMessage(identity, { title: "t", body: "b" }, NOW);
    const noSleep = async (): Promise<void> => {};
    let calls = 0;
    const id = await postMessage(bot, message, async () => (calls++ === 0 ? limited("0.5") : Response.json({ id: "777" })), noSleep);
    expect(id).toBe("777");
    expect(calls).toBe(2);
  });
});
