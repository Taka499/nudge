/**
 * The GitHub App side of a tap (plan decisions A2, A24, A26): sign the App's JWT, find the
 * installation covering the repository, mint a one-hour token scoped to that repository and send
 * the `repository_dispatch`. Pure by construction: the credentials, the clock and the fetch are
 * arguments. GitHub downloads App keys as PKCS#1 (`RSA PRIVATE KEY`); WebCrypto imports PKCS#8,
 * so `importPrivateKey` wraps the one into the other rather than asking the operator to convert.
 */

import type { Fetcher } from "./fetcher.ts";

export const GITHUB_API = "https://api.github.com";

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export type DispatchOutcome = { ok: true } | { ok: false; reason: string };

export class GitHubError extends Error {
  constructor(readonly status: number, readonly step: string) {
    super(`GitHub answered ${status} at ${step}`);
    this.name = "GitHubError";
  }
}

const RSA_SIGN = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Runs the whole dispatch and reports why it could not, in words a message can show. */
export async function dispatchToRepository(
  app: AppCredentials,
  repository: string,
  eventType: string,
  clientPayload: Record<string, string>,
  fetcher: Fetcher,
  now: Date,
): Promise<DispatchOutcome> {
  try {
    const jwt = await appJwt(app, now);
    const installation = await installationFor(repository, jwt, fetcher);
    if (installation === undefined) return { ok: false, reason: "the GitHub App is not installed on this repository" };
    const token = await installationToken(installation, repository, jwt, fetcher);
    await sendDispatch(repository, token, eventType, clientPayload, fetcher);
    return { ok: true };
  } catch (error) {
    if (error instanceof GitHubError) return { ok: false, reason: error.message };
    return { ok: false, reason: "GitHub could not be reached, or the App's key is unusable" };
  }
}

/** The App's own JWT: 10 minutes at most, dated a minute early for clock skew, as GitHub documents. */
export async function appJwt(app: AppCredentials, now: Date): Promise<string> {
  const key = await importPrivateKey(app.privateKeyPem);
  const seconds = Math.floor(now.getTime() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })));
  const signature = await crypto.subtle.sign(RSA_SIGN.name, key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

/** The installation id covering the repository, or undefined when the App is not installed on it. */
export async function installationFor(repository: string, jwt: string, fetcher: Fetcher): Promise<string | undefined> {
  const response = await fetcher(`${GITHUB_API}/repos/${repository}/installation`, { headers: headers(jwt) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new GitHubError(response.status, "installation lookup");
  const id = field(await response.json().catch(() => undefined), "id");
  if (typeof id !== "number") throw new GitHubError(response.status, "installation lookup");
  return String(id);
}

/** A token good for one hour, for this one repository, with the one permission a dispatch needs. */
export async function installationToken(installation: string, repository: string, jwt: string, fetcher: Fetcher): Promise<string> {
  const name = repository.slice(repository.indexOf("/") + 1);
  const response = await fetcher(`${GITHUB_API}/app/installations/${installation}/access_tokens`, {
    method: "POST",
    headers: headers(jwt),
    body: JSON.stringify({ repositories: [name], permissions: { contents: "write" } }),
  });
  if (!response.ok) throw new GitHubError(response.status, "installation token");
  const token = field(await response.json().catch(() => undefined), "token");
  if (typeof token !== "string" || token === "") throw new GitHubError(response.status, "installation token");
  return token;
}

export async function sendDispatch(
  repository: string,
  token: string,
  eventType: string,
  clientPayload: Record<string, string>,
  fetcher: Fetcher,
): Promise<void> {
  const response = await fetcher(`${GITHUB_API}/repos/${repository}/dispatches`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (!response.ok) throw new GitHubError(response.status, "dispatch");
}

function headers(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nudge",
    "Content-Type": "application/json",
  };
}

/** Imports a PEM private key, PKCS#8 (`PRIVATE KEY`) or PKCS#1 (`RSA PRIVATE KEY`, what GitHub downloads). */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  if (der === undefined) throw new Error("not a PEM private key");
  const pkcs8 = der.label === "RSA PRIVATE KEY" ? wrapPkcs1(der.bytes) : der.bytes;
  return crypto.subtle.importKey("pkcs8", pkcs8, RSA_SIGN, false, ["sign"]);
}

export function pemToDer(pem: string): { label: string; bytes: Uint8Array<ArrayBuffer> } | undefined {
  const begin = pem.indexOf("-----BEGIN ");
  const labelEnd = pem.indexOf("-----", begin + 11);
  const end = pem.indexOf("-----END ");
  if (begin < 0 || labelEnd < 0 || end < labelEnd) return undefined;
  const label = pem.slice(begin + 11, labelEnd);
  const body = pem.slice(labelEnd + 5, end).replace(/\s+/g, "");
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { label, bytes };
  } catch {
    return undefined;
  }
}

/** PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }. */
export function wrapPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetString = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octetString];
  const total = inner.length + pkcs1.length;
  const prefix = [0x30, ...derLength(total), ...inner];
  const out = new Uint8Array(new ArrayBuffer(prefix.length + pkcs1.length));
  out.set(prefix, 0);
  out.set(pkcs1, prefix.length);
  return out;
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/={1,2}$/, "");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
