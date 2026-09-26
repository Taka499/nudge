/**
 * Discord messages. `notifyMessage` is a pure builder returning exactly the JSON Discord expects;
 * `postMessage` is the one thin fetch, through the application's bot (plan decision A25: one
 * Discord path for every call). Every message starts with the repository name (A4) so one
 * channel can serve many repositories (A9).
 */

import type { Fetcher } from "./fetcher.ts";
import type { WorkflowIdentity } from "./oidc.ts";
import type { NotifyInput } from "./validate.ts";

/** Discord's embed field limits; longer text is cut with an ellipsis rather than refused. */
export const EMBED_LIMITS = { title: 256, description: 4096, footer: 2048 } as const;

export interface DiscordEmbed {
  title: string;
  description: string;
  url: string;
  footer: { text: string };
  timestamp: string;
}

/** Where the bot posts: its token and the one channel (Worker secrets, docs/adr/0004). */
export interface BotClient {
  token: string;
  channelId: string;
}

export const DISCORD_API = "https://discord.com/api/v10";

/** Longest wait honoured on a 429 before giving up; a consumer's job is waiting on the answer. */
export const MAX_RETRY_AFTER_MS = 5000;

export type Sleep = (ms: number) => Promise<void>;

export interface ChannelMessage {
  content: string;
  embeds: DiscordEmbed[];
  /** Never ping anyone, whatever a consumer writes in the body. */
  allowed_mentions: { parse: never[] };
}

export function notifyMessage(identity: WorkflowIdentity, input: NotifyInput, now: Date): ChannelMessage {
  return {
    content: `**${identity.repository}**`,
    embeds: [
      {
        title: truncate(input.title, EMBED_LIMITS.title),
        description: truncate(input.body, EMBED_LIMITS.description),
        url: input.url ?? identity.runUrl,
        footer: { text: truncate(footerText(identity), EMBED_LIMITS.footer) },
        timestamp: now.toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function footerText(identity: WorkflowIdentity): string {
  return `${shortRef(identity.ref)} · ${identity.sha.slice(0, 7)} · run ${identity.runId}`;
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`; anything else is shown as is. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export class DiscordError extends Error {
  constructor(readonly status: number, detail = "") {
    super(`Discord answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "DiscordError";
  }
}

/**
 * Posts into the bot's channel and returns the new message's id (the request id of A21). A 429
 * is retried once after the wait Discord asks for, if that wait is within MAX_RETRY_AFTER_MS.
 */
export async function postMessage(bot: BotClient, message: ChannelMessage, fetcher: Fetcher, sleep: Sleep): Promise<string> {
  const response = await retryingOnRateLimit(fetcher, sleep)(`${DISCORD_API}/channels/${bot.channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${bot.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new DiscordError(response.status);
  const id = messageId(await response.json().catch(() => undefined));
  if (id === undefined) throw new DiscordError(response.status, "no message id in the answer");
  return id;
}

/** Wraps a fetcher so that one 429 with a short `Retry-After` is retried once; anything else passes through. */
export function retryingOnRateLimit(fetcher: Fetcher, sleep: Sleep): Fetcher {
  return async (input, init) => {
    const first = await fetcher(input, init);
    const wait = retryDelayMs(first);
    if (wait === undefined) return first;
    await sleep(wait);
    return fetcher(input, init);
  };
}

/** Milliseconds to wait before one retry, or undefined when the answer is not a 429 worth retrying. */
export function retryDelayMs(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const header = response.headers.get("Retry-After") ?? "";
  // Seconds as a plain decimal and nothing else: "0x1", "1e3" or a blank header are not a wait.
  if (!/^\d+$/.test(header) && !/^\d+\.\d+$/.test(header)) return undefined;
  const seconds = Number(header);
  const ms = Math.ceil(seconds * 1000);
  return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

function messageId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("id" in raw)) return undefined;
  return typeof raw.id === "string" ? raw.id : undefined;
}
