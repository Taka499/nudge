/**
 * Test-only: an RSA key standing in for a GitHub App's private key, in both PEM forms GitHub and
 * WebCrypto know (PKCS#8 `PRIVATE KEY` and the PKCS#1 `RSA PRIVATE KEY` GitHub downloads).
 */

import { createPrivateKey } from "node:crypto";

export interface AppKey {
  pkcs8Pem: string;
  pkcs1Pem: string;
  publicKey: CryptoKey;
}

export async function createAppKey(): Promise<AppKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8Pem = toPem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const exported: unknown = createPrivateKey({ key: pkcs8Pem, format: "pem" }).export({ format: "pem", type: "pkcs1" });
  if (typeof exported !== "string") throw new Error("node:crypto did not export a PEM string");
  return { pkcs8Pem, pkcs1Pem: exported, publicKey: pair.publicKey };
}

export function toPem(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The JWT's payload as an object, for assertions on claims. */
export function jwtPayload(jwt: string): Record<string, unknown> {
  const segment = jwt.split(".")[1] ?? "";
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const parsed: unknown = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
  return typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
}
