import { describe, expect, test } from "bun:test";
import { DiscordError, EMBED_LIMITS, notifyMessage, postWebhook, shortRef, truncate } from "./discord.ts";
import type { WorkflowIdentity } from "./oidc.ts";
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

describe("postWebhook", () => {
  const message = notifyMessage(identity, { title: "t", body: "b" }, NOW);

  test("posts the message as JSON", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    await postWebhook("https://discord.test/hook", message, async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://discord.test/hook");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(message);
  });

  test("a non-2xx answer throws with the status", async () => {
    const failing = async (): Promise<Response> => new Response("rate limited", { status: 429 });
    const error = await postWebhook("https://discord.test/hook", message, failing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordError);
    if (error instanceof DiscordError) expect(error.status).toBe(429);
  });
});
