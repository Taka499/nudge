import { describe, expect, test } from "bun:test";
import { runAction } from "./testing/action-harness.ts";

/**
 * The composite actions, run for real with `curl` and `gh` faked (src/testing/action-harness.ts).
 * These are the consumer's side of the contract: the OIDC audience, the endpoint path, the JSON
 * body, the accepted status, and what reaches GITHUB_OUTPUT.
 */

const ENDPOINT = "https://nudge.example.test";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function after(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function post(run: { curl: string[][] }): { url?: string; body: unknown; auth?: string } {
  const call = run.curl.find((c) => c.includes("-X")) ?? [];
  const raw = after(call, "--data");
  return { url: after(call, "-X") === "POST" ? call[call.indexOf("-X") + 2] : undefined, body: raw === undefined ? undefined : JSON.parse(raw), auth: call.find((a) => a.startsWith("Authorization: ")) };
}

describe("actions/notify", () => {
  test("mints a token for the endpoint origin and posts the notification with it", async () => {
    const run = await runAction("notify", { endpoint: `${ENDPOINT}/`, title: "Weekly update", body: "all good", url: "https://github.com/x/y/pull/1" });
    expect(run.code).toBe(0);
    expect(run.curl[0]).toContain(`audience=${ENDPOINT}`);
    expect(post(run)).toEqual({ url: `${ENDPOINT}/notify`, body: { title: "Weekly update", body: "all good", url: "https://github.com/x/y/pull/1" }, auth: "Authorization: Bearer oidc.token" });
  });

  test("omits url when empty, fails on any other status with the instance's answer, and needs id-token: write", async () => {
    const plain = await runAction("notify", { endpoint: ENDPOINT, title: "t", body: "b" });
    expect(post(plain).body).toEqual({ title: "t", body: "b" });
    const refused = await runAction("notify", { endpoint: ENDPOINT, title: "t", body: "b" }, { status: "403", body: '{"error":"repository owner x is not served by this instance"}' });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("::error::Nudge answered 403: {\"error\":\"repository owner x is not served by this instance\"}");
    const noToken = await runAction("notify", { endpoint: ENDPOINT, title: "t", body: "b" }, { noIdToken: true });
    expect(noToken.code).toBe(1);
    expect(noToken.curl).toHaveLength(0);
    expect(noToken.stderr).toContain("id-token: write");
  });
});

describe("actions/request", () => {
  test("posts title, body, commit and the optional url and image, and outputs the request id", async () => {
    const run = await runAction("request", { endpoint: ENDPOINT, title: "New character", body: "Icon below", url: "https://github.com/x/y/pull/2", commit: SHA, image: "https://cdn.test/i.png" }, { status: "201", body: '{"id":"555"}' });
    expect(run.code).toBe(0);
    expect(post(run)).toEqual({ url: `${ENDPOINT}/request`, body: { title: "New character", body: "Icon below", commit: SHA, url: "https://github.com/x/y/pull/2", image: "https://cdn.test/i.png" }, auth: "Authorization: Bearer oidc.token" });
    expect(run.outputs).toEqual({ id: "555" });
  });

  test("omits empty url and image, and fails without a 201 or without an id", async () => {
    const plain = await runAction("request", { endpoint: ENDPOINT, title: "t", body: "b", commit: SHA }, { status: "201", body: '{"id":"7"}' });
    expect(post(plain).body).toEqual({ title: "t", body: "b", commit: SHA });
    const refused = await runAction("request", { endpoint: ENDPOINT, title: "t", body: "b", commit: "abc" }, { status: "400", body: '{"error":"commit must be a 40-character lowercase hex sha"}' });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("400");
    expect(refused.outputs).toEqual({});
    const okButWrong = await runAction("request", { endpoint: ENDPOINT, title: "t", body: "b", commit: SHA }, { status: "200", body: '{"id":"7"}' });
    expect(okButWrong.code).toBe(1);
    expect(okButWrong.outputs).toEqual({});
    const idless = await runAction("request", { endpoint: ENDPOINT, title: "t", body: "b", commit: SHA }, { status: "201", body: "{}" });
    expect(idless.code).toBe(1);
    expect(idless.outputs).toEqual({});
  });
});

describe("actions/resolve", () => {
  test("posts id, outcome and the optional detail, and accepts only 204", async () => {
    const run = await runAction("resolve", { endpoint: ENDPOINT, id: "555", outcome: "done", detail: "merged #42" });
    expect(run.code).toBe(0);
    expect(post(run)).toEqual({ url: `${ENDPOINT}/resolve`, body: { id: "555", outcome: "done", detail: "merged #42" }, auth: "Authorization: Bearer oidc.token" });
    const plain = await runAction("resolve", { endpoint: ENDPOINT, id: "555", outcome: "stale" });
    expect(post(plain).body).toEqual({ id: "555", outcome: "stale" });
    const other = await runAction("resolve", { endpoint: ENDPOINT, id: "555", outcome: "done" }, { status: "403", body: '{"error":"the request belongs to another repository"}' });
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("another repository");
  });
});

describe("actions/guard", () => {
  interface Pull {
    number: number;
    state: string;
    sha: string;
    /** The head's repository; another one means a fork. */
    repo?: string;
    base?: string;
    branch?: string;
  }
  const pulls = (entries: Pull[]): string =>
    JSON.stringify(entries.map((e) => ({ number: e.number, state: e.state, base: { ref: e.base ?? "develop" }, head: { sha: e.sha, ref: e.branch ?? "auto/sync-data", repo: e.repo === "" ? null : { full_name: e.repo ?? "Taka499/ss-assist" } } })));

  test("outputs the one open pull request whose head is the commit, ignoring closed ones and other heads", async () => {
    const run = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 41, state: "closed", sha: SHA }, { number: 42, state: "open", sha: SHA }, { number: 43, state: "open", sha: "f".repeat(40) }]) });
    expect(run.code).toBe(0);
    expect(run.outputs).toEqual({ number: "42" });
    expect(run.gh[0]).toContain(`repos/Taka499/ss-assist/commits/${SHA}/pulls`);
    expect(run.gh[0]).toContain("--paginate");
    expect(run.gh[0]).not.toContain("--jq");
  });

  test("never matches a pull request whose head lives in another repository, even at the same commit (#14)", async () => {
    const fork = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 42, state: "open", sha: SHA, repo: "stranger/ss-assist" }]) });
    expect(fork.code).toBe(1);
    expect(fork.outputs).toEqual({ stale: "true" });
    const deleted = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 42, state: "open", sha: SHA, repo: "" }]) });
    expect(deleted.code).toBe(1);
    const mixed = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 42, state: "open", sha: SHA, repo: "stranger/ss-assist" }, { number: 43, state: "open", sha: SHA }]) });
    expect(mixed.code).toBe(0);
    expect(mixed.outputs).toEqual({ number: "43" });
  });

  test("binds the match to the consumer's base and head branches when given (#14)", async () => {
    const two = [{ number: 42, state: "open", sha: SHA, base: "main", branch: "hotfix" }, { number: 43, state: "open", sha: SHA, base: "develop", branch: "auto/sync-data" }];
    const unbound = await runAction("guard", { commit: SHA }, { ghJson: pulls(two) });
    expect(unbound.code).toBe(1);
    expect(unbound.stderr).toContain("found 2");
    const byBase = await runAction("guard", { commit: SHA, base: "develop" }, { ghJson: pulls(two) });
    expect(byBase.outputs).toEqual({ number: "43" });
    const byHead = await runAction("guard", { commit: SHA, head: "hotfix" }, { ghJson: pulls(two) });
    expect(byHead.outputs).toEqual({ number: "42" });
    const neither = await runAction("guard", { commit: SHA, base: "release" }, { ghJson: pulls(two) });
    expect(neither.code).toBe(1);
    expect(neither.outputs).toEqual({ stale: "true" });
    expect(neither.stderr).toContain("into release");
    const hostile = await runAction("guard", { commit: SHA, base: 'develop" or true or "' }, { ghJson: pulls(two) });
    expect(hostile.code).toBe(1);
    expect(hostile.outputs).toEqual({ stale: "true" });
  });

  test("fails when no open pull request has that head, when two do, or when the commit is not a full sha", async () => {
    const moved = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 42, state: "open", sha: "f".repeat(40) }]) });
    expect(moved.code).toBe(1);
    expect(moved.stderr).toContain("found 0");
    expect(moved.outputs).toEqual({ stale: "true" });
    const two = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 42, state: "open", sha: SHA }, { number: 44, state: "open", sha: SHA }]) });
    expect(two.code).toBe(1);
    expect(two.stderr).toContain("found 2");
    expect(two.outputs).toEqual({ stale: "true" });
    const bad = await runAction("guard", { commit: "main" });
    expect(bad.code).toBe(1);
    expect(bad.gh).toHaveLength(0);
    expect(bad.outputs).toEqual({});
  });

  test("a failed lookup fails without saying stale, so the handler reports failed rather than stale", async () => {
    const down = await runAction("guard", { commit: SHA }, { ghFails: true });
    expect(down.code).toBe(1);
    expect(down.outputs).toEqual({});
  });

  test("talks to GitHub with the job's own token unless one is given", async () => {
    const own = await runAction("guard", { commit: SHA }, { ghJson: pulls([{ number: 1, state: "open", sha: SHA }]) });
    expect(own.code).toBe(0);
    expect(own.gh[0]).toContain("GH_TOKEN=github-token");
    const given = await runAction("guard", { commit: SHA, token: "my-token" }, { ghJson: pulls([{ number: 1, state: "open", sha: SHA }]) });
    expect(given.gh[0]).toContain("GH_TOKEN=my-token");
  });
});
