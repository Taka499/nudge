import { describe, expect, test } from "bun:test";

/**
 * wrangler.toml names no tenant (docs/adr/0004): every instance value is a Worker secret and the
 * custom domain is attached outside the file, so a fork never edits it. The file may contain only
 * the keys listed here; anything else (`routes`, `route`, `vars`, a KV or D1 binding with an
 * account-specific id) is a tenant value in disguise. A wrangler environment also inherits a
 * top-level `routes`, and an environment without its own would, when deployed, offer to take a
 * production custom domain away from the production Worker (plan § Surprises).
 */

// Generic Worker options a template may carry are listed; a tenant value has no place here.
const TOP_LEVEL_KEYS = ["name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "observability", "env"];
const ENVIRONMENT_KEYS = ["name", "workers_dev", "routes"];

async function config(): Promise<Record<string, unknown>> {
  const parsed: unknown = Bun.TOML.parse(await Bun.file(new URL("../wrangler.toml", import.meta.url)).text());
  if (typeof parsed !== "object" || parsed === null) throw new Error("wrangler.toml did not parse to a table");
  return { ...parsed };
}

function table(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

describe("wrangler.toml", () => {
  test("names no tenant: only the allowed keys appear, at the top level and in every environment", async () => {
    const top = await config();
    for (const key of Object.keys(top)) {
      expect({ key, allowed: TOP_LEVEL_KEYS.includes(key) }).toEqual({ key, allowed: true });
    }
    for (const [name, env] of Object.entries(table(top["env"]))) {
      for (const key of Object.keys(table(env))) {
        expect({ name, key, allowed: ENVIRONMENT_KEYS.includes(key) }).toEqual({ name, key, allowed: true });
      }
    }
  });

  test("every environment declares `routes = []`: none inherits a production domain, none carries one of its own", async () => {
    const envs = table((await config())["env"]);
    expect(Object.keys(envs).length).toBeGreaterThan(0);
    for (const [name, env] of Object.entries(envs)) {
      expect({ name, routes: table(env)["routes"] }).toEqual({ name, routes: [] });
    }
  });

  test("the acceptance instance has no routes and a different name", async () => {
    const top = await config();
    const acceptance = table(table(top["env"])["acceptance"]);
    expect(acceptance["routes"]).toEqual([]);
    expect(acceptance["name"]).not.toBe(top["name"]);
  });
});
