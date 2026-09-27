/**
 * Test-only: an Ed25519 key pair standing in for a Discord application, so `/interactions`
 * is tested against real signatures in the shape Discord sends them.
 */

export const TIMESTAMP = "1790121600";

export interface DiscordSigner {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

export async function createDiscordSigner(): Promise<DiscordSigner> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKeyHex: toHex(raw), privateKey: pair.privateKey };
}

export async function signInteraction(signer: DiscordSigner, body: string, timestamp = TIMESTAMP): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, signer.privateKey, new TextEncoder().encode(timestamp + body));
  return toHex(new Uint8Array(signature));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
