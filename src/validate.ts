/**
 * Request bodies, checked before anything is posted. Pure: unknown in, typed value or a
 * message the caller can return with 400. Length limits are applied by the message builder
 * (a long body is truncated, not refused); the Worker caps the raw request size separately.
 */

export interface NotifyInput {
  title: string;
  body: string;
  url?: string;
}

/** A `request` names the exact commit a tap approves (A5) and may show an image (A7). */
export interface RequestInput extends NotifyInput {
  commit: string;
  image?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseNotifyInput(raw: unknown): Parsed<NotifyInput> {
  return parseCommon(raw);
}

export function parseRequestInput(raw: unknown): Parsed<RequestInput> {
  const common = parseCommon(raw);
  if (!common.ok || !isRecord(raw)) return common.ok ? fail("body must be a JSON object") : common;
  const commit = raw["commit"];
  if (typeof commit !== "string" || !isFullSha(commit)) return fail("commit must be a 40-character lowercase hex sha");
  const image = raw["image"];
  if (image === undefined) return { ok: true, value: { ...common.value, commit } };
  if (typeof image !== "string" || !isHttpUrl(image)) return fail("image must be an http(s) URL");
  return { ok: true, value: { ...common.value, commit, image } };
}

function parseCommon(raw: unknown): Parsed<NotifyInput> {
  if (!isRecord(raw)) return fail("body must be a JSON object");
  const title = nonEmptyString(raw["title"]);
  if (title === undefined) return fail("title must be a non-empty string");
  const body = nonEmptyString(raw["body"]);
  if (body === undefined) return fail("body must be a non-empty string");
  const url = raw["url"];
  if (url === undefined) return { ok: true, value: { title, body } };
  if (typeof url !== "string" || !isHttpUrl(url)) return fail("url must be an http(s) URL");
  return { ok: true, value: { title, body, url } };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
