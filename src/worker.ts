/**
 * Nudge: GitHub Actions → Discord. Milestone 1 serves `POST /notify`.
 *
 * `handle` takes every dependency as an argument (fetch, clock, key set) so `worker.test.ts`
 * drives the whole request path with keys it generated; the default export wires the live ones.
 * Nothing here names a hostname, owner or channel: those are Worker secrets loaded from
 * .dev.vars (plan decision A13, docs/adr/0004).
 */

import { notifyMessage, postMessage, type BotClient, type Sleep } from "./discord.ts";
import type { Fetcher } from "./fetcher.ts";
import { isAllowedOwner, parseAllowedOwners } from "./gate.ts";
import { createJwksSource, type JwksSource } from "./jwks.ts";
import { OidcError, verifyGithubToken, type WorkflowIdentity } from "./oidc.ts";
import { parseNotifyInput } from "./validate.ts";

export interface Env {
  ALLOWED_OWNERS?: string;
  NUDGE_AUDIENCE?: string;
  /** The Discord application's bot token and the channel it posts to (A25). */
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CHANNEL_ID?: string;
}

export interface Deps {
  fetch: Fetcher;
  now: () => Date;
  jwks: JwksSource;
  /** Waits; injected so tests never sleep. Used for the one retry on a Discord 429. */
  sleep: Sleep;
}

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/notify") return json(404, { error: "not found" });
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
  return notify(request, env, deps);
}

async function notify(request: Request, env: Env, deps: Deps): Promise<Response> {
  const identity = await authenticate(request, env, deps);
  if (identity instanceof Response) return identity;
  if (!isAllowedOwner(identity.owner, parseAllowedOwners(env.ALLOWED_OWNERS))) {
    return json(403, { error: `repository owner ${identity.owner} is not served by this instance` });
  }

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseNotifyInput(body.json);
  if (!input.ok) return json(400, { error: input.error });

  const bot = botClient(env);
  if (bot instanceof Response) return bot;
  try {
    await postMessage(bot, notifyMessage(identity, input.value, deps.now()), deps.fetch, deps.sleep);
  } catch {
    return json(502, { error: "Discord refused the message" });
  }
  return new Response(null, { status: 204 });
}

function botClient(env: Env): BotClient | Response {
  if (!env.DISCORD_BOT_TOKEN) return json(500, { error: "instance has no DISCORD_BOT_TOKEN" });
  if (!env.DISCORD_CHANNEL_ID) return json(500, { error: "instance has no DISCORD_CHANNEL_ID" });
  return { token: env.DISCORD_BOT_TOKEN, channelId: env.DISCORD_CHANNEL_ID };
}

async function authenticate(request: Request, env: Env, deps: Deps): Promise<WorkflowIdentity | Response> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) return json(401, { error: "missing bearer token" });
  const audience = env.NUDGE_AUDIENCE ?? new URL(request.url).origin;
  const now = deps.now();
  try {
    return await verifyWithRefresh(token, audience, now, deps.jwks);
  } catch (error) {
    if (error instanceof OidcError) return json(401, { error: error.reason });
    return json(503, { error: "could not fetch GitHub's signing keys" });
  }
}

/** An unknown `kid` is retried once against a freshly fetched key set: GitHub rotates keys. */
async function verifyWithRefresh(token: string, audience: string, now: Date, jwks: JwksSource): Promise<WorkflowIdentity> {
  try {
    return await verifyGithubToken(token, audience, await jwks(now), now);
  } catch (error) {
    if (!(error instanceof OidcError) || error.reason !== "unknown key") throw error;
    return verifyGithubToken(token, audience, await jwks(now, true), now);
  }
}

export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

async function readJsonBody(request: Request): Promise<{ json: unknown } | Response> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) {
    return json(415, { error: "Content-Type must be application/json" });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
  try {
    const json: unknown = JSON.parse(text);
    return { json };
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }
}

function json(status: number, body: { error: string }, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const live: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  jwks: createJwksSource((input, init) => fetch(input, init)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, live);
  },
};
