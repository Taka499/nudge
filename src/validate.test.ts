import { describe, expect, test } from "bun:test";
import { isHttpUrl, parseNotifyInput } from "./validate.ts";

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
    for (const url of ["", "github.com/x", "javascript:alert(1)", "ftp://x", 1, null]) {
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
