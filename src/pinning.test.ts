import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * Consumers pin Nudge's actions by commit hash (docs/adr/0003). A hash pins only the action it names: a
 * nested `uses:` inside a composite action would still follow a movable tag, so the actions have none.
 * This repository's own workflows hold production credentials, so every action they use is pinned too.
 */

const root = new URL("../", import.meta.url).pathname;
const FULL_HASH = /@[0-9a-f]{40}$/;

async function yamlFiles(pattern: string): Promise<Array<{ path: string; doc: unknown }>> {
  const files: Array<{ path: string; doc: unknown }> = [];
  for await (const path of new Glob(pattern).scan({ cwd: root, dot: true })) {
    files.push({ path, doc: Bun.YAML.parse(await Bun.file(root + path).text()) });
  }
  return files;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function usesOf(steps: unknown): string[] {
  return list(steps).flatMap((step) => {
    const uses = record(step)["uses"];
    return typeof uses === "string" ? [uses] : [];
  });
}

function workflowUses(doc: unknown): string[] {
  return Object.values(record(record(doc)["jobs"])).flatMap((job) => {
    const called = record(job)["uses"];
    return [...usesOf(record(job)["steps"]), ...(typeof called === "string" ? [called] : [])];
  });
}

describe("action pinning", () => {
  test("no composite action contains a nested uses:, so a consumer's hash pin covers everything", async () => {
    const actions = await yamlFiles("actions/*/action.{yml,yaml}");
    expect(actions.length).toBeGreaterThan(0);
    for (const { path, doc } of actions) {
      expect({ path, nested: usesOf(record(record(doc)["runs"])["steps"]) }).toEqual({ path, nested: [] });
    }
  });

  test("every action this repository's workflows use is pinned to a full commit hash", async () => {
    const workflows = await yamlFiles(".github/workflows/*.{yml,yaml}");
    expect(workflows.length).toBeGreaterThan(0);
    for (const { path, doc } of workflows) {
      const unpinned = workflowUses(doc).filter((uses) => !uses.startsWith("./") && !FULL_HASH.test(uses));
      expect({ path, unpinned }).toEqual({ path, unpinned: [] });
    }
  });
});
