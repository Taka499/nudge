import { describe, expect, test } from "bun:test";

/**
 * wrangler.toml names no tenant (docs/adr/0004): every instance value is a Worker secret and the
 * custom domain is attached outside the file, so a fork never edits it. A wrangler environment
 * also inherits a top-level `routes`, and an environment without its own would, when deployed,
 * offer to take a production custom domain away from the production Worker (plan § Surprises).
 */

async function config(): Promise<Record<string, unknown>> {
  const parsed: unknown = Bun.TOML.parse(await Bun.file(new URL("../wrangler.toml", import.meta.url)).text());
  if (typeof parsed !== "object" || parsed === null) throw new Error("wrangler.toml did not parse to a table");
  return { ...parsed };
}

function table(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

describe("wrangler.toml", () => {
  test("names no tenant: no top-level routes, and no vars at any level", async () => {
    const top = await config();
    expect(top["routes"]).toBeUndefined();
    expect(top["vars"]).toBeUndefined();
    for (const [name, env] of Object.entries(table(top["env"]))) {
      expect({ name, vars: table(env)["vars"] }).toEqual({ name, vars: undefined });
    }
  });

  test("every environment declares its own routes, so none could inherit a production domain", async () => {
    const envs = table((await config())["env"]);
    expect(Object.keys(envs).length).toBeGreaterThan(0);
    for (const [name, env] of Object.entries(envs)) {
      const routes = table(env)["routes"];
      expect({ name, hasOwnRoutes: Array.isArray(routes) }).toEqual({ name, hasOwnRoutes: true });
    }
  });

  test("the acceptance instance has no routes and a different name", async () => {
    const top = await config();
    const acceptance = table(table(top["env"])["acceptance"]);
    expect(acceptance["routes"]).toEqual([]);
    expect(acceptance["name"]).not.toBe(top["name"]);
  });
});
