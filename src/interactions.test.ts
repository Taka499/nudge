import { beforeAll, describe, expect, test } from "bun:test";
import { MAX_REQUEST_AGE_MS, MAX_SIGNATURE_AGE_MS, hexToBytes, isFreshTimestamp, interactionType, parseAllowedUsers, parseCustomId, parseTap, settlePatch, tapVerdict, verifyDiscordSignature, type Tap } from "./interactions.ts";
import { NOW, SHA } from "./testing/oidc-fixture.ts";
import { TIMESTAMP, createDiscordSigner, signInteraction, type DiscordSigner } from "./testing/discord-fixture.ts";

let signer: DiscordSigner;
let other: DiscordSigner;
beforeAll(async () => {
  signer = await createDiscordSigner();
  other = await createDiscordSigner();
});

const BODY = '{"type":1}';

describe("hexToBytes", () => {
  test("decodes either case", () => {
    expect(Array.from(hexToBytes("00ff7Fa0") ?? [])).toEqual([0, 255, 127, 160]);
  });

  test("empty hex is zero bytes", () => {
    expect(hexToBytes("")?.length).toBe(0);
  });

  test("odd length and non-hex characters are refused", () => {
    expect(hexToBytes("abc")).toBeUndefined();
    expect(hexToBytes("zz")).toBeUndefined();
    expect(hexToBytes("0x00")).toBeUndefined();
  });
});

describe("verifyDiscordSignature", () => {
  test("a signature over timestamp + body under the key verifies", async () => {
    const signature = await signInteraction(signer, BODY);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, TIMESTAMP, BODY)).toBe(true);
  });

  test("another key, another body or another timestamp does not verify", async () => {
    const signature = await signInteraction(signer, BODY);
    expect(await verifyDiscordSignature(other.publicKeyHex, signature, TIMESTAMP, BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, TIMESTAMP, '{"type":2}')).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, "1790121601", BODY)).toBe(false);
  });

  test("a signature over the body alone, without the timestamp, does not verify", async () => {
    const signature = await signInteraction(signer, BODY, "");
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, TIMESTAMP, BODY)).toBe(false);
  });

  test("a missing or empty timestamp is refused even for a signature over the body alone", async () => {
    const signature = await signInteraction(signer, BODY, "");
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, "", BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, null, BODY)).toBe(false);
  });

  test("missing or malformed headers and keys are simply invalid", async () => {
    const signature = await signInteraction(signer, BODY);
    expect(await verifyDiscordSignature(signer.publicKeyHex, null, TIMESTAMP, BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, null, BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature, "", BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex, signature.slice(2), TIMESTAMP, BODY)).toBe(false);
    expect(await verifyDiscordSignature(signer.publicKeyHex.slice(2), signature, TIMESTAMP, BODY)).toBe(false);
    expect(await verifyDiscordSignature("not hex", signature, TIMESTAMP, BODY)).toBe(false);
  });

  test("a flipped bit in the signature does not verify", async () => {
    const signature = await signInteraction(signer, BODY);
    const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(await verifyDiscordSignature(signer.publicKeyHex, flipped, TIMESTAMP, BODY)).toBe(false);
  });
});

describe("interactionType", () => {
  test("reads a numeric type", () => {
    expect(interactionType({ type: 1 })).toBe(1);
    expect(interactionType({ type: 3, data: {} })).toBe(3);
  });

  test("anything else has no type", () => {
    expect(interactionType(undefined)).toBeUndefined();
    expect(interactionType(null)).toBeUndefined();
    expect(interactionType([1])).toBeUndefined();
    expect(interactionType({})).toBeUndefined();
    expect(interactionType({ type: "1" })).toBeUndefined();
  });
});

/** A component interaction as Discord sends it, with the parts a tap reads. */
export function componentInteraction(overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 3,
    id: "900",
    token: "itoken",
    channel_id: "123",
    data: { custom_id: `approve:${SHA}`, component_type: 2 },
    member: { user: { id: "42", username: "taka" } },
    message: {
      id: "555",
      timestamp: NOW.toISOString(),
      content: "**Taka499/ss-assist**",
      embeds: [{ title: "New character", author: { name: "Taka499/ss-assist" } }],
      components: [{ type: 1, components: [{ type: 2, custom_id: `approve:${SHA}` }, { type: 2, custom_id: `decline:${SHA}` }] }],
      ...message,
    },
    ...overrides,
  };
}

const tap = (): Tap => ({ action: "approve", sha: SHA, userId: "42", channelId: "123", messageId: "555", repository: "Taka499/ss-assist", postedAt: NOW, answered: false });

describe("parseTap", () => {
  test("reads action, commit, user, message id, repository, time and whether the buttons are still there", () => {
    expect(parseTap(componentInteraction())).toEqual(tap());
    expect(parseTap(componentInteraction({ data: { custom_id: `decline:${SHA}` } }))?.action).toBe("decline");
    expect(parseTap(componentInteraction({ member: undefined, user: { id: "7" } }))?.userId).toBe("7");
    expect(parseTap(componentInteraction({}, { components: [] }))?.answered).toBe(true);
    expect(parseTap(componentInteraction({}, { components: undefined }))?.answered).toBe(true);
  });

  test("is undefined for anything that is not a button press on a request message", () => {
    expect(parseTap({ type: 3 })).toBeUndefined();
    expect(parseTap(componentInteraction({ data: { custom_id: "other" } }))).toBeUndefined();
    expect(parseTap(componentInteraction({ member: undefined }))).toBeUndefined();
    expect(parseTap(componentInteraction({}, { embeds: [] }))).toBeUndefined();
    expect(parseTap(componentInteraction({}, { embeds: [{ author: {} }] }))).toBeUndefined();
    expect(parseTap(componentInteraction({}, { timestamp: "yesterday" }))).toBeUndefined();
    expect(parseTap(componentInteraction({}, { id: "" }))).toBeUndefined();
    expect(parseTap(componentInteraction({ channel_id: undefined }))).toBeUndefined();
  });

  test("a pressed button that is not one of the message's own buttons is not a tap", () => {
    const other = [{ type: 1, components: [{ type: 2, custom_id: `approve:${"f".repeat(40)}` }] }];
    expect(parseTap(componentInteraction({}, { components: other }))).toBeUndefined();
    const notAButton = [{ type: 1, components: [{ type: 3, custom_id: `approve:${SHA}` }] }];
    expect(parseTap(componentInteraction({}, { components: notAButton }))).toBeUndefined();
  });
});

describe("isFreshTimestamp", () => {
  test("accepts a timestamp within the window either way and refuses anything else", () => {
    const seconds = NOW.getTime() / 1000;
    expect(isFreshTimestamp(String(seconds), NOW)).toBe(true);
    expect(isFreshTimestamp(String(seconds - MAX_SIGNATURE_AGE_MS / 1000), NOW)).toBe(true);
    expect(isFreshTimestamp(String(seconds + MAX_SIGNATURE_AGE_MS / 1000), NOW)).toBe(true);
    expect(isFreshTimestamp(String(seconds - MAX_SIGNATURE_AGE_MS / 1000 - 1), NOW)).toBe(false);
    expect(isFreshTimestamp(String(seconds + MAX_SIGNATURE_AGE_MS / 1000 + 1), NOW)).toBe(false);
    expect(isFreshTimestamp("", NOW)).toBe(false);
    expect(isFreshTimestamp("soon", NOW)).toBe(false);
    expect(isFreshTimestamp("1e9", NOW)).toBe(false);
  });
});

describe("parseCustomId", () => {
  test("accepts approve/decline with a full sha and nothing else", () => {
    expect(parseCustomId(`approve:${SHA}`)).toEqual({ action: "approve", sha: SHA });
    expect(parseCustomId(`decline:${SHA}`)).toEqual({ action: "decline", sha: SHA });
    expect(parseCustomId(`merge:${SHA}`)).toBeUndefined();
    expect(parseCustomId("approve:abc")).toBeUndefined();
    expect(parseCustomId(`approve:${SHA}:x`)).toBeUndefined();
    expect(parseCustomId("approve")).toBeUndefined();
  });
});

describe("tapVerdict", () => {
  test("checks the allowlist first, then whether it was answered, then the age", () => {
    expect(tapVerdict(tap(), ["42"], NOW)).toBe("allowed");
    expect(tapVerdict(tap(), ["43"], NOW)).toBe("not allowed");
    expect(tapVerdict(tap(), [], NOW)).toBe("not allowed");
    expect(tapVerdict({ ...tap(), answered: true }, ["43"], NOW)).toBe("not allowed");
    expect(tapVerdict({ ...tap(), answered: true }, ["42"], NOW)).toBe("already answered");
    expect(tapVerdict(tap(), ["42"], new Date(NOW.getTime() + MAX_REQUEST_AGE_MS))).toBe("allowed");
    expect(tapVerdict(tap(), ["42"], new Date(NOW.getTime() + MAX_REQUEST_AGE_MS + 1))).toBe("expired");
  });
});

describe("parseAllowedUsers", () => {
  test("splits on commas and ignores blanks", () => {
    expect(parseAllowedUsers("42, 43 ,,")).toEqual(["42", "43"]);
    expect(parseAllowedUsers(undefined)).toEqual([]);
    expect(parseAllowedUsers("")).toEqual([]);
  });
});

describe("settlePatch", () => {
  test("an approved dispatch removes the buttons; a failed one keeps them and says why", () => {
    expect(settlePatch(tap(), { ok: true })).toEqual({ content: "**Taka499/ss-assist** — approved by <@42>, dispatched", components: [], allowed_mentions: { parse: [] } });
    const failed = settlePatch(tap(), { ok: false, reason: "GitHub answered 500 at dispatch" });
    expect(failed?.content).toBe("**Taka499/ss-assist** — approve failed: GitHub answered 500 at dispatch; tap again to retry");
    expect(failed).not.toHaveProperty("components");
  });

  test("a decline changes nothing on success and notes a failed dispatch", () => {
    expect(settlePatch({ ...tap(), action: "decline" }, { ok: true })).toBeUndefined();
    expect(settlePatch({ ...tap(), action: "decline" }, { ok: false, reason: "x" })?.content).toBe("**Taka499/ss-assist** — declined by <@42>; the repository was not told: x");
  });
});
