/**
 * Nudge: GitHub Actions → Discord. Serves `POST /notify`, `POST /request` (a message with Approve
 * and Decline buttons), `POST /interactions` (Discord's delivery of a button press, which
 * dispatches to the repository through the GitHub App) and `POST /resolve` (the repository
 * reporting what it did, written onto the message).
 *
 * `handle` takes every dependency as an argument (fetch, clock, key set, sleep, waitUntil) so the
 * tests drive the whole request path with keys they generated; the default export wires the live
 * ones. Nothing here names a hostname, owner or channel: those are Worker secrets loaded from
 * .dev.vars (plan decision A13, docs/adr/0004).
 */

import { editMessage, fetchMessage, notifyMessage, postMessage, requestMessage, requestRepository, resolvedPatch, statusLine, type BotClient, type MessagePatch, type Sleep } from "./discord.ts";
import type { Fetcher } from "./fetcher.ts";
import { isAllowedOwner, parseAllowedOwners } from "./gate.ts";
import { dispatchToRepository, type AppCredentials } from "./github-app.ts";
import {
  EPHEMERAL_FLAG,
  INTERACTION_COMPONENT,
  INTERACTION_PING,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_UPDATE,
  RESPONSE_PONG,
  RESPONSE_UPDATE_MESSAGE,
  interactionType,
  isFreshTimestamp,
  parseAllowedUsers,
  parseTap,
  settlePatch,
  tapVerdict,
  verifyDiscordSignature,
  type Tap,
} from "./interactions.ts";
import { createJwksSource, type JwksSource } from "./jwks.ts";
import { OidcError, verifyGithubToken, type WorkflowIdentity } from "./oidc.ts";
import { parseNotifyInput, parseRequestInput, parseResolveInput } from "./validate.ts";

export interface Env {
  ALLOWED_OWNERS?: string;
  NUDGE_AUDIENCE?: string;
  /** The Discord application's bot token and the channel it posts to (A25). */
  DISCORD_BOT_TOKEN?: string;
  DISCORD_CHANNEL_ID?: string;
  /** The Discord application's public key, hex; verifies `/interactions`. */
  DISCORD_PUBLIC_KEY?: string;
  /** Discord user ids allowed to tap Approve or Decline, comma-separated (A5). */
  DISCORD_ALLOWED_USERS?: string;
  /** The GitHub App that sends `repository_dispatch` (A2). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export interface Deps {
  fetch: Fetcher;
  now: () => Date;
  jwks: JwksSource;
  /** Waits; injected so tests never sleep. Used for the one retry on a Discord 429. */
  sleep: Sleep;
  /** Keeps work running after the response is sent: a tap must be answered within 3 s, the dispatch takes longer. */
  waitUntil: (work: Promise<unknown>) => void;
}

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const route = ROUTES[new URL(request.url).pathname];
  if (!route) return json(404, { error: "not found" });
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
  return route(request, env, deps);
}

type Route = (request: Request, env: Env, deps: Deps) => Promise<Response>;

const ROUTES: Partial<Record<string, Route>> = {
  "/notify": notify,
  "/request": request,
  "/resolve": resolve,
  "/interactions": interactions,
};

async function notify(request: Request, env: Env, deps: Deps): Promise<Response> {
  const identity = await authorize(request, env, deps);
  if (identity instanceof Response) return identity;
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

/** Posts the question with its buttons; the message id is the request id (A21). */
async function request(request: Request, env: Env, deps: Deps): Promise<Response> {
  const identity = await authorize(request, env, deps);
  if (identity instanceof Response) return identity;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseRequestInput(body.json);
  if (!input.ok) return json(400, { error: input.error });
  const bot = botClient(env);
  if (bot instanceof Response) return bot;
  try {
    const id = await postMessage(bot, requestMessage(identity, input.value, deps.now()), deps.fetch, deps.sleep);
    return Response.json({ id }, { status: 201 });
  } catch {
    return json(502, { error: "Discord refused the message" });
  }
}

/** The repository reports the outcome (A27); only the repository the message names may (A21). */
async function resolve(request: Request, env: Env, deps: Deps): Promise<Response> {
  const identity = await authorize(request, env, deps);
  if (identity instanceof Response) return identity;
  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const input = parseResolveInput(body.json);
  if (!input.ok) return json(400, { error: input.error });
  const bot = botClient(env);
  if (bot instanceof Response) return bot;
  try {
    const message = await fetchMessage(bot, input.value.id, deps.fetch, deps.sleep);
    if (message === undefined) return json(404, { error: "unknown request" });
    const repository = requestRepository(message);
    if (repository === undefined) return json(404, { error: "unknown request" });
    if (repository !== identity.repository) return json(403, { error: "the request belongs to another repository" });
    await editMessage(bot, input.value.id, resolvedPatch(repository, input.value), deps.fetch, deps.sleep);
  } catch {
    return json(502, { error: "Discord refused the message" });
  }
  return new Response(null, { status: 204 });
}

/** Discord removes an endpoint that accepts a bad signature, so nothing is read before it is checked. */
async function interactions(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return json(500, { error: "instance has no DISCORD_PUBLIC_KEY" });
  const text = await readLimitedText(request);
  if (text instanceof Response) return text;
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!(await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, text))) {
    return json(401, { error: "invalid request signature" });
  }
  if (timestamp === null || !isFreshTimestamp(timestamp, deps.now())) return json(401, { error: "stale request timestamp" });
  const raw = parseJson(text);
  const type = interactionType(raw);
  if (type === INTERACTION_PING) return Response.json({ type: RESPONSE_PONG });
  if (type === INTERACTION_COMPONENT) return tap(raw, env, deps);
  return json(400, { error: `unsupported interaction type ${type ?? "none"}` });
}

/**
 * A button press (A5, A21, A27). Discord wants an answer within 3 s, so the tap is answered at
 * once and the dispatch runs on in `waitUntil`; `settle` then records the outcome on the message.
 * The signature binds the press to this application and the channel check binds it to the one
 * channel the bot serves; the application id itself needs no check, since only the application's
 * private key produces a signature its public key accepts.
 */
function tap(raw: unknown, env: Env, deps: Deps): Response {
  const pressed = parseTap(raw);
  if (!pressed) return json(400, { error: "not a button press on a request message" });
  const bot = botClient(env);
  if (bot instanceof Response) return bot;
  const app = appCredentials(env);
  if (app instanceof Response) return app;
  if (pressed.channelId !== bot.channelId) return ephemeral("This message is not in the channel this instance serves.");
  const verdict = tapVerdict(pressed, parseAllowedUsers(env.DISCORD_ALLOWED_USERS), deps.now());
  if (verdict === "not allowed") return ephemeral("You are not on this instance's list of people who may answer.");
  if (verdict === "already answered") return ephemeral("This request has already been answered.");
  if (verdict === "expired") return updateMessage({ content: statusLine(pressed.repository, "expired: not answered within 7 days"), components: [] });
  deps.waitUntil(settle(pressed, bot, app, deps));
  if (pressed.action === "decline") {
    return updateMessage({ content: statusLine(pressed.repository, `declined by <@${pressed.userId}>`), components: [] });
  }
  return Response.json({ type: RESPONSE_DEFERRED_UPDATE });
}

async function settle(pressed: Tap, bot: BotClient, app: AppCredentials, deps: Deps): Promise<void> {
  const eventType = pressed.action === "approve" ? "nudge-approved" : "nudge-declined";
  const payload = { id: pressed.messageId, commit: pressed.sha, actor: pressed.userId };
  const outcome = await dispatchToRepository(app, pressed.repository, eventType, payload, deps.fetch, deps.now());
  const patch = settlePatch(pressed, outcome);
  // A failed edit is left to reject: the runtime logs it, and the buttons that stay invite a retry the consumer's guard tolerates.
  if (patch) await editMessage(bot, pressed.messageId, patch, deps.fetch, deps.sleep);
}

function ephemeral(content: string): Response {
  return Response.json({ type: RESPONSE_CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL_FLAG, allowed_mentions: { parse: [] } } });
}

function updateMessage(patch: Omit<MessagePatch, "allowed_mentions">): Response {
  return Response.json({ type: RESPONSE_UPDATE_MESSAGE, data: { ...patch, allowed_mentions: { parse: [] } } });
}

function botClient(env: Env): BotClient | Response {
  if (!env.DISCORD_BOT_TOKEN) return json(500, { error: "instance has no DISCORD_BOT_TOKEN" });
  if (!env.DISCORD_CHANNEL_ID) return json(500, { error: "instance has no DISCORD_CHANNEL_ID" });
  return { token: env.DISCORD_BOT_TOKEN, channelId: env.DISCORD_CHANNEL_ID };
}

function appCredentials(env: Env): AppCredentials | Response {
  if (!env.GITHUB_APP_ID) return json(500, { error: "instance has no GITHUB_APP_ID" });
  if (!env.GITHUB_APP_PRIVATE_KEY) return json(500, { error: "instance has no GITHUB_APP_PRIVATE_KEY" });
  return { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };
}

/** A verified workflow identity from an allowed owner, or the refusal to return. */
async function authorize(request: Request, env: Env, deps: Deps): Promise<WorkflowIdentity | Response> {
  const identity = await authenticate(request, env, deps);
  if (identity instanceof Response) return identity;
  if (!isAllowedOwner(identity.owner, parseAllowedOwners(env.ALLOWED_OWNERS))) {
    return json(403, { error: `repository owner ${identity.owner} is not served by this instance` });
  }
  return identity;
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
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) {
    return json(415, { error: "Content-Type must be application/json" });
  }
  const text = await readLimitedText(request);
  if (text instanceof Response) return text;
  const parsed = parseJson(text);
  return parsed === undefined ? json(400, { error: "body is not valid JSON" }) : { json: parsed };
}

async function readLimitedText(request: Request): Promise<string | Response> {
  const tooLarge = (): Response => json(413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) return tooLarge();
  const text = await request.text();
  return text.length > MAX_BODY_BYTES ? tooLarge() : text;
}

/** Parsed JSON, or undefined when the text is not JSON (`undefined` itself is not a JSON value). */
function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function json(status: number, body: { error: string }, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The part of Cloudflare's ExecutionContext this Worker uses. */
interface Context {
  waitUntil(work: Promise<unknown>): void;
}

const live: Omit<Deps, "waitUntil"> = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  jwks: createJwksSource((input, init) => fetch(input, init)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handle(request, env, { ...live, waitUntil: (work) => ctx.waitUntil(work) });
  },
};
