import { describe, expect, test } from "bun:test";
import { isHttpUrl, parseNotifyInput, parseRequestInput } from "./validate.ts";

describe("parseNotifyInput", () => {
  test("accepts title and body, with and without url", () => {
    expect(parseNotifyInput({ title: "Weekly update", body: "ok" })).toEqual({ ok: true, value: { title: "Weekly update", body: "ok" } });
    expect(parseNotifyInput({ title: "t", body: "b", url: "https://github.com/x/y/pull/1" })).toEqual({
      ok: true,
      value: { title: "t", body: "b", url: "https://github.com/x/y/pull/1" },
    });
  });

  test("ignores unknown keys", () => {
    expect(parseNotifyInput({ title: "t", body: "b", extra: 1 })).toEqual({ ok: true, value: { title: "t", body: "b" } });
  });

  test("refuses non-objects", () => {
    for (const raw of [null, undefined, "text", 42, [], ["title"]]) {
      expect(parseNotifyInput(raw)).toEqual({ ok: false, error: "body must be a JSON object" });
    }
  });

  test("refuses a missing, empty, blank or non-string title", () => {
    for (const title of [undefined, "", "   ", 1, null, {}]) {
      expect(parseNotifyInput({ title, body: "b" })).toEqual({ ok: false, error: "title must be a non-empty string" });
    }
  });

  test("refuses a missing, empty, blank or non-string body", () => {
    for (const body of [undefined, "", "\n", 1, null, []]) {
      expect(parseNotifyInput({ title: "t", body })).toEqual({ ok: false, error: "body must be a non-empty string" });
    }
  });

  test("refuses a url that is not http(s)", () => {
    for (const url of ["", "github.com/x", "javascript:alert(1)", "ftps://x", "mailto:x@y.test", 1, null]) {
      expect(parseNotifyInput({ title: "t", body: "b", url })).toEqual({ ok: false, error: "url must be an http(s) URL" });
    }
  });
});

describe("isHttpUrl", () => {
  test("accepts http and https only", () => {
    expect(isHttpUrl("https://a.test/p?q=1")).toBe(true);
    expect(isHttpUrl("http://a.test")).toBe(true);
    expect(isHttpUrl("HTTPS://A.TEST")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("parseRequestInput", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  test("needs everything notify needs plus a full lowercase sha, and takes an optional image URL", () => {
    expect(parseRequestInput({ title: "t", body: "b", commit: sha })).toEqual({ ok: true, value: { title: "t", body: "b", commit: sha } });
    expect(parseRequestInput({ title: "t", body: "b", url: "https://x.test/pr/1", commit: sha, image: "https://x.test/i.png" })).toEqual({
      ok: true,
      value: { title: "t", body: "b", url: "https://x.test/pr/1", commit: sha, image: "https://x.test/i.png" },
    });
  });

  test("refuses a missing, short, uppercase or non-hex commit, and a non-URL image", () => {
    for (const commit of [undefined, "abc123", sha.toUpperCase(), sha.replace("0", "g"), 42]) {
      const result = parseRequestInput({ title: "t", body: "b", commit });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("commit");
    }
    const image = parseRequestInput({ title: "t", body: "b", commit: sha, image: "ftp://x" });
    expect(image.ok).toBe(false);
    if (!image.ok) expect(image.error).toContain("image");
    expect(parseRequestInput({ title: "", body: "b", commit: sha }).ok).toBe(false);
    expect(parseRequestInput("nope").ok).toBe(false);
  });
});
