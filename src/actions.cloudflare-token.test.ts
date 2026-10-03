import { describe, expect, test } from "bun:test";
import { runAction, type ActionRun, type Fakes } from "./testing/action-harness.ts";

/**
 * `actions/cloudflare-token` (plan decisions A29, A30), run for real with `curl` and `date` faked:
 * the verify call goes only to Cloudflare, and what reaches the instance depends on Cloudflare's
 * answer and the day. Every case fixes the clock, so the 30-day line and the first-week heartbeat
 * are exact, and every run is checked for the token outside the Cloudflare call.
 */

const ENDPOINT = "https://nudge.example.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "cf-secret-token";
const DAY = 86_400;
/** 2026-10-14 03:17 UTC: outside the first week of the month. */
const MID = Date.UTC(2026, 9, 14, 3, 17) / 1000;
/** 2026-10-07 and 2026-10-08, the last day of the first week and the day after. */
const DAY_7 = Date.UTC(2026, 9, 7, 3, 17) / 1000;
const DAY_8 = Date.UTC(2026, 9, 8, 3, 17) / 1000;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function verified(expiresOn: string | undefined, status = "active"): NonNullable<Fakes["cloudflare"]> {
  const result = { id: "abc", status, ...(expiresOn === undefined ? {} : { expires_on: expiresOn }) };
  return { status: "200", body: JSON.stringify({ success: true, errors: [], messages: [], result }) };
}

/** Runs the action, and requires that the token appears only in the call to Cloudflare. */
async function check(fakes: Fakes, inputs: Record<string, string> = { "account-id": ACCOUNT }): Promise<ActionRun> {
  const run = await runAction("cloudflare-token", { endpoint: ENDPOINT, token: SECRET, ...inputs }, fakes);
  const elsewhere = [run.stdout, run.stderr, ...run.curl.filter((c) => !c.some((a) => a.startsWith("https://api.cloudflare.com/"))).flat()];
  expect(elsewhere.filter((text) => text.includes(SECRET))).toEqual([]);
  return run;
}

/** The first sentence of the posted body. */
function reason(run: ActionRun): string | undefined {
  return posted(run)?.body.split(". ")[0];
}

/** The JSON body posted to the instance, or undefined when nothing was posted. */
function posted(run: ActionRun): { title: string; body: string } | undefined {
  const call = run.curl.find((c) => c.includes(`${ENDPOINT}/notify`));
  if (call === undefined) return undefined;
  const parsed: unknown = JSON.parse(call[call.indexOf("--data") + 1] ?? "null");
  const record = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
  const title = "title" in record ? String(record.title) : "";
  const body = "body" in record ? String(record.body) : "";
  return { title, body };
}

describe("actions/cloudflare-token: expiry", () => {
  test("warns within 30 days, naming the date; the token goes only to Cloudflare's account endpoint", async () => {
    const run = await check({ now: MID, cloudflare: verified(iso(MID + 10 * DAY)) });
    expect(run.code).toBe(0);
    expect(run.curl[0]).toContain(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`);
    expect(run.curl[0]).toContain(`Authorization: Bearer ${SECRET}`);
    expect(run.curl[1]).toContain(`audience=${ENDPOINT}`);
    expect(posted(run)?.title).toBe("Cloudflare token expires in 10 days");
    expect(posted(run)?.body).toContain("expires on 2026-10-24 (UTC)");
    expect(run.stdout).toContain("::warning::Cloudflare token expires in 10 days");
  });

  test("the line is 30 days: exactly 30 days away warns, one second more posts nothing", async () => {
    const near = await check({ now: MID, cloudflare: verified(iso(MID + 30 * DAY)) });
    expect(posted(near)?.title).toBe("Cloudflare token expires in 30 days");
    const far = await check({ now: MID, cloudflare: verified(iso(MID + 30 * DAY + 1)) });
    expect(far.code).toBe(0);
    expect(far.curl).toHaveLength(1);
    expect(far.stdout).toContain("in 30 days. Nothing to post.");
  });

  test("says 1 day, today, and expired as the date comes and goes", async () => {
    const titles = [];
    for (const offset of [DAY + 60, 60, -60]) {
      titles.push(posted(await check({ now: MID, cloudflare: verified(iso(MID + offset)) }))?.title);
    }
    expect(titles).toEqual(["Cloudflare token expires in 1 day", "Cloudflare token expires today", "Cloudflare token expired"]);
  });

  test("reads Cloudflare's date with fractional seconds, and uses the user endpoint without an account id", async () => {
    const run = await check({ now: MID, cloudflare: verified("2026-10-20T00:00:00.123Z") }, {});
    expect(run.curl[0]).toContain("https://api.cloudflare.com/client/v4/user/tokens/verify");
    expect(posted(run)?.title).toBe("Cloudflare token expires in 5 days");
  });
});

describe("actions/cloudflare-token: the monthly OK line", () => {
  test("posts one OK line with the date on days 1-7 of a month, and nothing from day 8", async () => {
    const day7 = await check({ now: DAY_7, cloudflare: verified(iso(DAY_7 + 100 * DAY)) });
    expect(day7.code).toBe(0);
    expect(posted(day7)?.title).toBe("Cloudflare token OK");
    expect(posted(day7)?.body).toContain("It expires on 2027-01-15 (UTC), in 100 days.");
    expect(posted(day7)?.body).toContain("a month without it means this scheduled check has stopped");
    const day8 = await check({ now: DAY_8, cloudflare: verified(iso(DAY_8 + 100 * DAY)) });
    expect(day8.code).toBe(0);
    expect(posted(day8)).toBeUndefined();
  });

  test("a token with no expiry date gets the OK line in the first week and nothing otherwise", async () => {
    const first = await check({ now: DAY_7, cloudflare: verified(undefined) });
    expect(posted(first)?.body).toContain("The token has no expiry date.");
    const later = await check({ now: MID, cloudflare: verified(undefined) });
    expect(later.code).toBe(0);
    expect(posted(later)).toBeUndefined();
  });
});

describe("actions/cloudflare-token: rejected or not checked", () => {
  test("a refused token still reaches Discord with Cloudflare's reason, then fails the job", async () => {
    const body = JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null });
    const run = await check({ now: MID, cloudflare: { status: "401", body } });
    expect(run.code).toBe(1);
    expect(posted(run)?.title).toBe("Cloudflare rejected the token");
    expect(reason(run)).toBe("HTTP 401: Invalid API Token");
    expect(run.stderr).toContain("::error::HTTP 401: Invalid API Token.");
  });

  test("an expired or disabled status and a malformed error list are rejections", async () => {
    const answers: Fakes["cloudflare"][] = [verified(iso(MID + 100 * DAY), "expired"), verified(undefined, "disabled"), { status: "403", body: '{"success":false,"errors":"oops"}' }, { status: "400", body: '{"success":false,"errors":[1,{"message":2},{"message":"bad"}]}' }];
    const reasons = [];
    for (const cloudflare of answers) {
      const run = await check({ now: MID, cloudflare });
      expect([run.code, posted(run)?.title]).toEqual([1, "Cloudflare rejected the token"]);
      reasons.push(reason(run));
    }
    expect(reasons).toEqual(["HTTP 200, token status expired", "HTTP 200, token status disabled", "HTTP 403", "HTTP 400: bad"]);
  });

  test("no answer, a failed transfer, throttling, a 5xx, unexpected JSON or an unreadable date post 'check failed' and fail the job", async () => {
    const transferFailed = { ...verified(iso(MID + 100 * DAY)), exit: 18 };
    const throttled = { status: "429", body: '{"success":false,"errors":[{"code":10000,"message":"rate limited"}]}' };
    const timedOut = { status: "408", body: '{"success":false,"errors":[{"code":10000,"message":"request timeout"}]}' };
    const answers: Fakes["cloudflare"][] = [{ status: "000", body: "", exit: 6 }, transferFailed, throttled, timedOut, { status: "502", body: "<html>bad gateway</html>" }, { status: "503", body: '{"success":false,"errors":[]}' }, { status: "200", body: '{"success":true,"result":"x"}' }, { status: "200", body: "[1]" }, verified("next week")];
    const reasons = [];
    for (const cloudflare of answers) {
      const run = await check({ now: MID, cloudflare });
      expect([run.code, posted(run)?.title]).toEqual([1, "Cloudflare token check failed"]);
      reasons.push(reason(run));
    }
    expect(reasons).toEqual([
      "Cloudflare could not be asked: curl exit 6, HTTP 000",
      "Cloudflare could not be asked: curl exit 18, HTTP 200",
      "Cloudflare could not be asked: HTTP 429",
      "Cloudflare could not be asked: HTTP 408",
      "Cloudflare could not be asked: HTTP 502, no JSON answer",
      "Cloudflare could not be asked: HTTP 503",
      "Cloudflare answered without the token details",
      "Cloudflare could not be asked: HTTP 200, no JSON answer",
      "Cloudflare gave an expiry date this check cannot read: next week",
    ]);
  });

  test("fails with the instance's answer when the instance refuses the post", async () => {
    const run = await check({ now: MID, cloudflare: verified(iso(MID + DAY)), status: "403", body: '{"error":"repository owner x is not served by this instance"}' });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("::error::Nudge answered 403");
  });

  test("refuses an empty token, a malformed account id, or a job without id-token: write, calling nothing", async () => {
    const runs = [
      await runAction("cloudflare-token", { endpoint: ENDPOINT, token: "" }, { now: MID }),
      await check({ now: MID }, { "account-id": "../../zones" }),
      await check({ now: MID }, { "account-id": "abc123" }),
      await check({ now: MID, noIdToken: true }),
    ];
    expect(runs.map((r) => [r.code, r.curl.length, r.stderr.includes("::error::")])).toEqual(runs.map(() => [1, 0, true]));
  });
});
