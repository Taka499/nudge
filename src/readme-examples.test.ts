import { describe, expect, test } from "bun:test";

/**
 * The README's YAML examples are what consumers paste into repositories whose handlers hold merge
 * rights, and `src/actions.test.ts` cannot see them. These checks read every fenced YAML block:
 * it must parse, every Nudge action in it must be pinned by a full commit hash (docs/adr/0003),
 * and every step that runs `gh` must name the repository, because a handler job has no checkout
 * for `gh` to infer it from (issue #14).
 */

const readme = new URL("../README.md", import.meta.url);
const FULL_HASH = /@[0-9a-f]{40}( |$)/;
/** A gh invocation that needs to know the repository. */
const GH_COMMAND = /\bgh (pr|api|issue)\b/;

async function yamlBlocks(): Promise<string[]> {
  const text = await Bun.file(readme).text();
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** Shell lines with backslash continuations joined and trailing comments removed. */
function logicalLines(script: string): string[] {
  return script.replace(/\\\n\s*/g, " ").split("\n").map((line) => line.replace(/\s+#.*$/, ""));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** Every step in every job of a workflow, or of a bare `jobs`-less fragment of jobs. */
function steps(doc: unknown): Record<string, unknown>[] {
  const top = record(doc);
  const jobs = record(top["jobs"] ?? top);
  return Object.values(jobs).flatMap((job) => {
    const list = record(job)["steps"];
    return Array.isArray(list) ? list.map(record) : [];
  });
}

describe("README examples", () => {
  test("every YAML block parses", async () => {
    const blocks = await yamlBlocks();
    expect(blocks.length).toBeGreaterThan(2);
    for (const block of blocks) expect(() => Bun.YAML.parse(block)).not.toThrow();
  });

  test("every Nudge action is pinned by a full commit hash", async () => {
    const uses = (await yamlBlocks()).flatMap((b) => steps(Bun.YAML.parse(b))).map((s) => s["uses"]).filter((u): u is string => typeof u === "string");
    const nudge = uses.filter((x) => x.startsWith("Taka499/nudge/"));
    expect(nudge.length).toBeGreaterThan(3);
    for (const u of nudge) expect({ u, pinned: FULL_HASH.test(u) }).toEqual({ u, pinned: true });
  });

  test("every step that runs gh names the repository, since a handler job has no checkout (#14)", async () => {
    const running = (await yamlBlocks()).flatMap((b) => steps(Bun.YAML.parse(b))).filter((s) => typeof s["run"] === "string" && logicalLines(String(s["run"])).some((line) => GH_COMMAND.test(line)));
    expect(running.length).toBeGreaterThan(0);
    for (const step of running) {
      const run = String(step["run"]);
      const repoEnv = record(step["env"])["GH_REPO"];
      const viaEnv = typeof repoEnv === "string" && repoEnv.trim() !== "";
      // Or the gh invocation itself carries the repository: on its own logical line (backslash
      // continuations joined), comments stripped, so a mention elsewhere does not count.
      const viaFlag = logicalLines(run).filter((line) => GH_COMMAND.test(line)).every((line) => /(--repo|-R)[ =]\S/.test(line) || line.includes("$GITHUB_REPOSITORY"));
      expect({ run, named: viaEnv || viaFlag }).toEqual({ run, named: true });
    }
  });
});
