/**
 * GitHub Actions OIDC token verification (docs/adr/0002).
 *
 * Pure by construction: the token, the audience this instance expects, GitHub's key set and the
 * clock are all arguments, so every rule here is exercised by `oidc.test.ts` with keys the test
 * generated itself. Fetching the key set is `jwks.ts`'s job; the Worker wires the two together.
 */

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** Tolerated clock difference between GitHub and this Worker, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

/** What a verified token says about the workflow run that sent it. */
export interface WorkflowIdentity {
  /** `owner/name`, exactly as GitHub spells it. */
  repository: string;
  /** The `repository_owner` claim: the user or organisation. */
  owner: string;
  sha: string;
  ref: string;
  runId: string;
  /** `https://github.com/<repository>/actions/runs/<runId>`. */
  runUrl: string;
}

/** `lib.dom`'s JsonWebKey has no `kid`; GitHub's keys carry one. */
export interface Jwk extends JsonWebKey {
  kid?: string;
}

export interface JsonWebKeySet {
  keys: Jwk[];
}

/** Thrown for any token the Worker must answer with 401. `reason` is safe to return to the caller. */
export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OidcError";
  }
}

const RSA_VERIFY = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export async function verifyGithubToken(
  token: string,
  audience: string,
  jwks: JsonWebKeySet,
  now: Date,
): Promise<WorkflowIdentity> {
  const [headerSegment, payloadSegment, signatureSegment, extra] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment || extra !== undefined) {
    throw new OidcError("malformed token");
  }

  const header = decodeJson(headerSegment);
  const key = await selectKey(header, jwks);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(RSA_VERIFY.name, key, base64UrlToBytes(signatureSegment), signed);
  if (!valid) throw new OidcError("invalid signature");

  const claims = decodeJson(payloadSegment);
  checkStandardClaims(claims, audience, now);
  return identityFrom(claims);
}

function decodeJson(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  } catch {
    throw new OidcError("malformed token");
  }
  if (!isRecord(parsed)) throw new OidcError("malformed token");
  return parsed;
}

async function selectKey(header: Record<string, unknown>, jwks: JsonWebKeySet): Promise<CryptoKey> {
  if (header["alg"] !== "RS256") throw new OidcError("unsupported algorithm");
  const kid = header["kid"];
  if (typeof kid !== "string") throw new OidcError("unknown key");
  const jwk = jwks.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) throw new OidcError("unknown key");
  try {
    return await crypto.subtle.importKey("jwk", jwk, RSA_VERIFY, false, ["verify"]);
  } catch {
    throw new OidcError("unknown key");
  }
}

function checkStandardClaims(claims: Record<string, unknown>, audience: string, now: Date): void {
  if (claims["iss"] !== GITHUB_ISSUER) throw new OidcError("wrong issuer");
  if (!audienceMatches(claims["aud"], audience)) throw new OidcError("wrong audience");
  const seconds = Math.floor(now.getTime() / 1000);
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS <= seconds) throw new OidcError("token expired");
  const nbf = claims["nbf"];
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - CLOCK_SKEW_SECONDS > seconds)) {
    throw new OidcError("token not yet valid");
  }
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.some((entry: unknown) => entry === expected);
}

function identityFrom(claims: Record<string, unknown>): WorkflowIdentity {
  const repository = readString(claims, "repository");
  const runId = readString(claims, "run_id");
  return {
    repository,
    owner: readString(claims, "repository_owner"),
    sha: readString(claims, "sha"),
    ref: readString(claims, "ref"),
    runId,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
  };
}

function readString(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value === "") throw new OidcError(`missing claim ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new OidcError("malformed token");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
