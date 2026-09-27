import { beforeAll, describe, expect, test } from "bun:test";
import {
  GITHUB_API,
  GitHubError,
  appJwt,
  dispatchToRepository,
  importPrivateKey,
  installationFor,
  installationToken,
  pemToDer,
  sendDispatch,
  wrapPkcs1,
} from "./github-app.ts";
import { createAppKey, jwtPayload, type AppKey } from "./testing/app-fixture.ts";
import { bodyText, requestUrl } from "./testing/http.ts";
import { NOW } from "./testing/oidc-fixture.ts";

let key: AppKey;
beforeAll(async () => {
  key = await createAppKey();
});

const REPO = "Taka499/ss-assist";

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** A fake GitHub: records calls and answers the three endpoints a dispatch touches. */
function github(options: { installed?: boolean; tokenStatus?: number; dispatchStatus?: number; lookupStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), body: bodyText(init) ? JSON.parse(bodyText(init)) : undefined });
    if (url === `${GITHUB_API}/repos/${REPO}/installation`) {
      if (options.lookupStatus !== undefined) return new Response(null, { status: options.lookupStatus });
      return options.installed === false ? new Response(null, { status: 404 }) : Response.json({ id: 42 });
    }
    if (url === `${GITHUB_API}/app/installations/42/access_tokens`) {
      return options.tokenStatus === undefined ? Response.json({ token: "ghs_x" }, { status: 201 }) : new Response(null, { status: options.tokenStatus });
    }
    if (url === `${GITHUB_API}/repos/${REPO}/dispatches`) return new Response(null, { status: options.dispatchStatus ?? 204 });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetcher };
}

describe("appJwt", () => {
  test("is an RS256 JWT for the App, dated a minute early and valid nine minutes, that the public key verifies", async () => {
    const jwt = await appJwt({ appId: "7", privateKeyPem: key.pkcs8Pem }, NOW);
    const [header, payload, signature] = jwt.split(".");
    expect(jwtPayload(`${header}.${payload}.x`)).toEqual({ iat: NOW.getTime() / 1000 - 60, exp: NOW.getTime() / 1000 + 540, iss: "7" });
    expect(JSON.parse(atob((header ?? "").replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ alg: "RS256", typ: "JWT" });
    const sigBytes = Uint8Array.from(atob((signature ?? "").replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - ((signature ?? "").length % 4)) % 4)), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key.publicKey, sigBytes, new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });

  test("accepts the PKCS#1 key GitHub downloads as well as PKCS#8, and the two sign identically", async () => {
    const a = await appJwt({ appId: "7", privateKeyPem: key.pkcs1Pem }, NOW);
    const b = await appJwt({ appId: "7", privateKeyPem: key.pkcs8Pem }, NOW);
    expect(a).toBe(b);
  });

  test("a key that is not PEM, or PEM of something else, is refused", async () => {
    expect(await importPrivateKey("not a key").catch((e: unknown) => e)).toBeInstanceOf(Error);
    expect(await importPrivateKey("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----").catch((e: unknown) => e)).toBeInstanceOf(Error);
    expect(pemToDer("-----BEGIN X-----\n@@@\n-----END X-----")).toBeUndefined();
  });

  test("wrapPkcs1 encodes DER lengths in both short and long form", () => {
    expect(Array.from(wrapPkcs1(new Uint8Array([1, 2, 3])).slice(0, 2))).toEqual([0x30, 3 + 3 + 15 + 2]);
    const long = wrapPkcs1(new Uint8Array(300));
    expect(Array.from(long.slice(0, 4))).toEqual([0x30, 0x82, 0x01, 300 + 22 - 256]);
    expect(long.length).toBe(4 + 22 + 300);
  });
});

describe("GitHub calls", () => {
  test("installationFor answers the id, undefined on 404, and throws on anything else", async () => {
    expect(await installationFor(REPO, "jwt", github().fetcher)).toBe("42");
    expect(await installationFor(REPO, "jwt", github({ installed: false }).fetcher)).toBeUndefined();
    const error = await installationFor(REPO, "jwt", github({ lookupStatus: 500 }).fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) expect(error.step).toBe("installation lookup");
  });

  test("installationToken asks for this repository and contents: write only", async () => {
    const gh = github();
    expect(await installationToken("42", REPO, "jwt", gh.fetcher)).toBe("ghs_x");
    expect(gh.calls[0]).toMatchObject({ method: "POST", auth: "Bearer jwt" });
    expect(gh.calls[0]?.body).toEqual({ repositories: ["ss-assist"], permissions: { contents: "write" } });
    expect(await installationToken("42", REPO, "jwt", github({ tokenStatus: 403 }).fetcher).catch((e: unknown) => e)).toBeInstanceOf(GitHubError);
  });

  test("sendDispatch posts the event and payload with the installation token", async () => {
    const gh = github();
    await sendDispatch(REPO, "ghs_x", "nudge-approved", { id: "1", commit: "c", actor: "u" }, gh.fetcher);
    expect(gh.calls[0]).toMatchObject({ url: `${GITHUB_API}/repos/${REPO}/dispatches`, method: "POST", auth: "Bearer ghs_x", body: { event_type: "nudge-approved", client_payload: { id: "1", commit: "c", actor: "u" } } });
    expect(await sendDispatch(REPO, "ghs_x", "x", {}, github({ dispatchStatus: 422 }).fetcher).catch((e: unknown) => e)).toBeInstanceOf(GitHubError);
  });

  test("every call carries GitHub's Accept, version and a User-Agent", async () => {
    const seen: Headers[] = [];
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    };
    await sendDispatch(REPO, "t", "x", {}, fetcher);
    expect(seen[0]?.get("Accept")).toBe("application/vnd.github+json");
    expect(seen[0]?.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(seen[0]?.get("User-Agent")).toBe("nudge");
  });
});

describe("dispatchToRepository", () => {
  const app = (): { appId: string; privateKeyPem: string } => ({ appId: "7", privateKeyPem: key.pkcs1Pem });

  test("looks up the installation with the App JWT, mints the token, dispatches with it", async () => {
    const gh = github();
    expect(await dispatchToRepository(app(), REPO, "nudge-approved", { id: "1", commit: "c", actor: "u" }, gh.fetcher, NOW)).toEqual({ ok: true });
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(gh.calls[0]?.auth?.split(".")).toHaveLength(3);
    expect(gh.calls[1]?.auth).toBe(gh.calls[0]?.auth);
    expect(gh.calls[2]?.auth).toBe("Bearer ghs_x");
  });

  test("reports why it could not, in words for the message", async () => {
    expect(await dispatchToRepository(app(), REPO, "x", {}, github({ installed: false }).fetcher, NOW)).toEqual({ ok: false, reason: "the GitHub App is not installed on this repository" });
    expect(await dispatchToRepository(app(), REPO, "x", {}, github({ dispatchStatus: 500 }).fetcher, NOW)).toEqual({ ok: false, reason: "GitHub answered 500 at dispatch" });
    expect(await dispatchToRepository({ appId: "7", privateKeyPem: "junk" }, REPO, "x", {}, github().fetcher, NOW)).toMatchObject({ ok: false });
    const down = async (): Promise<Response> => { throw new Error("network"); };
    expect(await dispatchToRepository(app(), REPO, "x", {}, down, NOW)).toEqual({ ok: false, reason: "GitHub could not be reached, or the App's key is unusable" });
  });
});
