import { describe, expect, test } from "bun:test";

/**
 * wrangler.toml is the instance configuration (plan decision A13). A wrangler environment inherits
 * the top-level `routes`, so an environment without its own `routes` would, when deployed, offer to
 * take the production custom domain away from the production Worker. These checks keep every
 * non-production environment off the production hostname.
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
  test("every environment declares its own routes, so none inherits the production domain", async () => {
    const envs = table((await config())["env"]);
    expect(Object.keys(envs).length).toBeGreaterThan(0);
    for (const [name, env] of Object.entries(envs)) {
      const routes = table(env)["routes"];
      expect({ name, hasOwnRoutes: Array.isArray(routes) }).toEqual({ name, hasOwnRoutes: true });
    }
  });

  test("the acceptance instance has no routes, a different name, and never allows this repository's owner", async () => {
    const top = await config();
    const acceptance = table(table(top["env"])["acceptance"]);
    expect(acceptance["routes"]).toEqual([]);
    expect(acceptance["name"]).not.toBe(top["name"]);
    const allowed = table(acceptance["vars"])["ALLOWED_OWNERS"];
    expect(typeof allowed).toBe("string");
    const owners = (typeof allowed === "string" ? allowed : "").toLowerCase().split(",").map((o) => o.trim());
    expect(owners).not.toContain("taka499");
  });
});
