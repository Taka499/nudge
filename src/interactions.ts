/**
 * Discord interactions (plan § Plan of Work, Milestone 2). Discord delivers every button press
 * to the application's Interactions Endpoint URL, signed with Ed25519 over the timestamp header
 * followed by the raw body, and removes an endpoint that accepts a bad signature (plan
 * § Surprises). Pure: the public key, headers and body are arguments; nothing is fetched.
 */

import { statusLine, type MessagePatch, type TapAction } from "./discord.ts";
import type { DispatchOutcome } from "./github-app.ts";
import { isFullSha } from "./validate.ts";

/** Discord's interaction and response type numbers used here. */
export const INTERACTION_PING = 1;
export const RESPONSE_PONG = 1;

const ED25519 = { name: "Ed25519" } as const;

/** Hex string → bytes over an explicit ArrayBuffer (see plan § Surprises); undefined if not hex. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * True only when `signatureHex` is the Ed25519 signature of `timestamp + body` under
 * `publicKeyHex`. Any malformed input is simply not a valid signature; WebCrypto refuses keys and
 * signatures of the wrong length. A missing timestamp is refused outright, or a signature over
 * the body alone would pass.
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  const publicKey = hexToBytes(publicKeyHex);
  const signature = hexToBytes(signatureHex ?? "");
  if (!publicKey || !signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, signature, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

/** The interaction's `type`, or undefined when the body is not an interaction at all. */
export function interactionType(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) return undefined;
  return typeof raw.type === "number" ? raw.type : undefined;
}

/** A button press: Discord's MESSAGE_COMPONENT interaction and the responses used here. */
export const INTERACTION_COMPONENT = 3;
export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_DEFERRED_UPDATE = 6;
export const RESPONSE_UPDATE_MESSAGE = 7;
/** Message flag: visible only to the user who tapped. */
export const EPHEMERAL_FLAG = 64;

/**
 * A signed request whose timestamp is further than this from the Worker's clock is refused: the
 * signature proves Discord sent it, the window proves it was not captured and replayed later.
 */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** True when `timestamp` (Discord's, in seconds) is within MAX_SIGNATURE_AGE_MS of `now`. */
export function isFreshTimestamp(timestamp: string, now: Date): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  return Math.abs(now.getTime() - Number(timestamp) * 1000) <= MAX_SIGNATURE_AGE_MS;
}

/** A request older than this is answered as expired (plan decision A5). */
export const MAX_REQUEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything a tap decides on, read from the interaction and the message it carries (A21). */
export interface Tap {
  action: TapAction;
  sha: string;
  userId: string;
  /** Where the press happened; must be the instance's channel. */
  channelId: string;
  messageId: string;
  repository: string;
  postedAt: Date;
  /** The buttons are gone, so someone already answered. */
  answered: boolean;
}

/** The tap, or undefined when the interaction is not a button press on a request message. */
export function parseTap(raw: unknown): Tap | undefined {
  const customId = str(field(field(raw, "data"), "custom_id"));
  const userId = str(field(field(field(raw, "member"), "user"), "id")) ?? str(field(field(raw, "user"), "id"));
  const message = field(raw, "message");
  const messageId = str(field(message, "id"));
  const timestamp = str(field(message, "timestamp"));
  const embeds = field(message, "embeds");
  const repository = str(field(field(Array.isArray(embeds) ? embeds[0] : undefined, "author"), "name"));
  const channelId = str(field(raw, "channel_id"));
  const rows = field(message, "components");
  const hasRows = Array.isArray(rows) && rows.length > 0;
  const buttons = buttonIds(rows);
  const parsed = customId === undefined ? undefined : parseCustomId(customId);
  if (!parsed || userId === undefined || channelId === undefined || messageId === undefined || timestamp === undefined || repository === undefined) return undefined;
  const postedAt = new Date(timestamp);
  if (Number.isNaN(postedAt.getTime())) return undefined;
  // The pressed button must be one of this message's own; a message with other buttons is not a request.
  // A message with no buttons left is a request already answered (a stale client), reported as such below.
  if (hasRows && !buttons.includes(customId ?? "")) return undefined;
  return { ...parsed, userId, channelId, messageId, repository, postedAt, answered: !hasRows };
}

export function parseCustomId(id: string): { action: TapAction; sha: string } | undefined {
  const [action, sha, extra] = id.split(":");
  if (extra !== undefined || sha === undefined || !isFullSha(sha)) return undefined;
  return action === "approve" || action === "decline" ? { action, sha } : undefined;
}

export type Verdict = "allowed" | "not allowed" | "already answered" | "expired";

/** The tap rules of A5, in the order they are reported to the person tapping. */
export function tapVerdict(tap: Tap, allowedUsers: readonly string[], now: Date): Verdict {
  if (!allowedUsers.includes(tap.userId)) return "not allowed";
  if (tap.answered) return "already answered";
  if (now.getTime() - tap.postedAt.getTime() > MAX_REQUEST_AGE_MS) return "expired";
  return "allowed";
}

/** `DISCORD_ALLOWED_USERS`: Discord user ids, comma-separated. Empty allows nobody. */
export function parseAllowedUsers(value: string | undefined): string[] {
  return (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
}

/** What the message says once the dispatch has been attempted; undefined when nothing changes. */
export function settlePatch(tap: Tap, outcome: DispatchOutcome): MessagePatch | undefined {
  const who = `<@${tap.userId}>`;
  const line = (status: string): string => statusLine(tap.repository, status);
  if (tap.action === "approve") {
    return outcome.ok
      ? { content: line(`approved by ${who}, dispatched`), components: [], allowed_mentions: { parse: [] } }
      : { content: line(`approve failed: ${outcome.reason}; tap again to retry`), allowed_mentions: { parse: [] } };
  }
  if (outcome.ok) return undefined;
  return { content: line(`declined by ${who}; the repository was not told: ${outcome.reason}`), allowed_mentions: { parse: [] } };
}

/** The custom_ids of every button (component type 2) in the message's action rows. */
function buttonIds(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  return components.flatMap((row: unknown) => {
    const inner = field(row, "components");
    if (!Array.isArray(inner)) return [];
    return inner.filter((c: unknown) => field(c, "type") === 2).map((b: unknown) => str(field(b, "custom_id"))).filter((id): id is string => id !== undefined);
  });
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
