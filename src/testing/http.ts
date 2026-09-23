/** Test-only helpers to read what a fake `fetch` was given without stringifying objects blindly. */

export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof Request ? input.url : input.href;
}

export function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
