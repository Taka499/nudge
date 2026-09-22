/**
 * Discord messages. `notifyMessage` is a pure builder returning exactly the JSON the
 * webhook expects; `postWebhook` is the one thin fetch. Every message starts with the
 * repository name (plan decision A4) so one channel can serve many repositories (A9).
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

export interface WebhookMessage {
  content: string;
  embeds: DiscordEmbed[];
  /** Never ping anyone, whatever a consumer writes in the body. */
  allowed_mentions: { parse: never[] };
}

export function notifyMessage(identity: WorkflowIdentity, input: NotifyInput, now: Date): WebhookMessage {
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
  constructor(readonly status: number) {
    super(`Discord webhook answered ${status}`);
    this.name = "DiscordError";
  }
}

export async function postWebhook(webhookUrl: string, message: WebhookMessage, fetcher: Fetcher): Promise<void> {
  const response = await fetcher(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new DiscordError(response.status);
}
