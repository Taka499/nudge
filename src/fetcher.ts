/**
 * The one shape of `fetch` this code needs. Bun's `typeof fetch` carries extras such as
 * `preconnect`, which a test fake has no reason to implement.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
