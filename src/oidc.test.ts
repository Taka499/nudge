import { beforeAll, describe, expect, test } from "bun:test";
import { CLOCK_SKEW_SECONDS, OidcError, base64UrlToBytes, verifyGithubToken } from "./oidc.ts";
import { AUDIENCE, NOW, SHA, b64url, createSigner, mint, standardClaims, type Signer } from "./testing/oidc-fixture.ts";

let signer: Signer;
beforeAll(async () => {
  signer = await createSigner();
});

const seconds = Math.floor(NOW.getTime() / 1000);

async function reasonOf(token: string, audience = AUDIENCE, jwks = signer.jwks, now = NOW): Promise<string> {
  try {
    await verifyGithubToken(token, audience, jwks, now);
  } catch (error) {
    if (error instanceof OidcError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("verifyGithubToken", () => {
  test("a well-formed token yields the workflow identity", async () => {
    const identity = await verifyGithubToken(await mint(signer), AUDIENCE, signer.jwks, NOW);
    expect(identity).toEqual({
      repository: "Taka499/nudge",
      owner: "Taka499",
      sha: SHA,
      ref: "refs/heads/main",
      runId: "123456",
      runUrl: "https://github.com/Taka499/nudge/actions/runs/123456",
    });
  });

  test("the audience may be an array containing the instance", async () => {
    const token = await mint(signer, standardClaims({ aud: ["https://other.test", AUDIENCE] }));
    expect(await reasonOf(token)).toBe("accepted");
    expect(await reasonOf(await mint(signer, standardClaims({ aud: ["https://other.test"] })))).toBe("wrong audience");
  });

  test("a token for another instance is refused", async () => {
    expect(await reasonOf(await mint(signer, standardClaims({ aud: "https://nudge.tia.run" })))).toBe("wrong audience");
    expect(await reasonOf(await mint(signer), "https://nudge.tia.run")).toBe("wrong audience");
  });

  test("expiry honours the clock skew boundary", async () => {
    expect(await reasonOf(await mint(signer, standardClaims({ exp: seconds - CLOCK_SKEW_SECONDS + 1 })))).toBe("accepted");
    expect(await reasonOf(await mint(signer, standardClaims({ exp: seconds - CLOCK_SKEW_SECONDS })))).toBe("token expired");
    expect(await reasonOf(await mint(signer, standardClaims({ exp: "soon" })))).toBe("token expired");
    expect(await reasonOf(await mint(signer, standardClaims({ exp: undefined })))).toBe("token expired");
  });

  test("not-before honours the clock skew boundary", async () => {
    expect(await reasonOf(await mint(signer, standardClaims({ nbf: seconds + CLOCK_SKEW_SECONDS })))).toBe("accepted");
    expect(await reasonOf(await mint(signer, standardClaims({ nbf: seconds + CLOCK_SKEW_SECONDS + 1 })))).toBe("token not yet valid");
    expect(await reasonOf(await mint(signer, standardClaims({ nbf: undefined })))).toBe("accepted");
  });

  test("another issuer with a valid signature is refused", async () => {
    expect(await reasonOf(await mint(signer, standardClaims({ iss: "https://accounts.google.com" })))).toBe("wrong issuer");
  });

  test("a tampered payload fails the signature check", async () => {
    const token = await mint(signer);
    const [h = "", p = "", s = ""] = token.split(".");
    const original: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
    if (typeof original !== "object" || original === null) throw new Error("fixture produced a non-object payload");
    const forgedSegment = b64url(JSON.stringify({ ...original, repository_owner: "attacker" }));
    expect(await reasonOf(`${h}.${forgedSegment}.${s}`)).toBe("invalid signature");
  });

  test("a token signed by an unknown key is refused", async () => {
    const other = await createSigner("other");
    expect(await reasonOf(await mint(other))).toBe("unknown key");
    expect(await reasonOf(await mint(other, standardClaims(), { alg: "RS256", kid: signer.kid }))).toBe("invalid signature");
    expect(await reasonOf(await mint(signer, standardClaims(), { alg: "RS256" }))).toBe("unknown key");
  });

  test("only RS256 is accepted", async () => {
    for (const alg of ["none", "HS256", "RS512", undefined]) {
      expect(await reasonOf(await mint(signer, standardClaims(), { alg, kid: signer.kid }))).toBe("unsupported algorithm");
    }
  });

  test("malformed tokens are refused without throwing anything else", async () => {
    for (const token of ["", "a.b", "a.b.c.d", "!!!.@@@.###", `${"x".repeat(10)}.${"y".repeat(10)}.zz`]) {
      expect(await reasonOf(token)).toBe("malformed token");
    }
  });

  test("a token missing a workflow claim is refused", async () => {
    for (const claim of ["repository", "repository_owner", "sha", "ref", "run_id"]) {
      expect(await reasonOf(await mint(signer, standardClaims({ [claim]: undefined })))).toBe(`missing claim ${claim}`);
      expect(await reasonOf(await mint(signer, standardClaims({ [claim]: "" })))).toBe(`missing claim ${claim}`);
      expect(await reasonOf(await mint(signer, standardClaims({ [claim]: 42 })))).toBe(`missing claim ${claim}`);
    }
  });

  test("an empty key set refuses everything", async () => {
    expect(await reasonOf(await mint(signer), AUDIENCE, { keys: [] })).toBe("unknown key");
  });
});

describe("base64UrlToBytes", () => {
  test("decodes with and without padding", () => {
    expect(new TextDecoder().decode(base64UrlToBytes("aGk"))).toBe("hi");
    expect(new TextDecoder().decode(base64UrlToBytes("aGk="))).toBe("hi");
    expect(base64UrlToBytes("")).toEqual(new Uint8Array(0));
    expect(Array.from(base64UrlToBytes("-_8"))).toEqual([0xfb, 0xff]);
  });
});
