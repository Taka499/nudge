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

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseNotifyInput(raw: unknown): Parsed<NotifyInput> {
  if (!isRecord(raw)) return fail("body must be a JSON object");
  const record = raw;
  const title = nonEmptyString(record["title"]);
  if (title === undefined) return fail("title must be a non-empty string");
  const body = nonEmptyString(record["body"]);
  if (body === undefined) return fail("body must be a non-empty string");
  const url = record["url"];
  if (url === undefined) return ok({ title, body });
  if (typeof url !== "string" || !isHttpUrl(url)) return fail("url must be an http(s) URL");
  return ok({ title, body, url });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

function ok(value: NotifyInput): Parsed<NotifyInput> {
  return { ok: true, value };
}

function fail(error: string): Parsed<NotifyInput> {
  return { ok: false, error };
}
