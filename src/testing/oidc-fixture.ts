/**
 * Test-only: an RSA signer that mints GitHub-shaped OIDC tokens, so verification is tested
 * end to end against real signatures rather than a mocked verifier.
 */

import type { JsonWebKeySet, Jwk } from "../oidc.ts";

export const NOW = new Date("2026-09-23T00:00:00Z");
export const AUDIENCE = "https://nudge.example.test";
export const SHA = "0123456789abcdef0123456789abcdef01234567";

export interface Signer {
  kid: string;
  jwks: JsonWebKeySet;
  privateKey: CryptoKey;
}

export async function createSigner(kid = "test-key"): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk: Jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { kid, jwks: { keys: [publicJwk] }, privateKey: pair.privateKey };
}

export function standardClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(NOW.getTime() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: AUDIENCE,
    exp: seconds + 300,
    nbf: seconds - 10,
    iat: seconds - 10,
    repository: "Taka499/nudge",
    repository_owner: "Taka499",
    sha: SHA,
    ref: "refs/heads/main",
    run_id: "123456",
    ...overrides,
  };
}

export async function mint(
  signer: Signer,
  claims: Record<string, unknown> = standardClaims(),
  header: Record<string, unknown> = { alg: "RS256", kid: signer.kid, typ: "JWT" },
): Promise<string> {
  const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(signed));
  return `${signed}.${b64url(new Uint8Array(signature))}`;
}

export function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
