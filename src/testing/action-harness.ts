/**
 * Test-only: runs a composite action's bash step the way GitHub would, with `curl` and `gh`
 * replaced by fakes on PATH that record what they were asked and answer what the test says.
 * Nothing touches the network. Each fake appends one record per call to a log: the arguments,
 * NUL-separated, then a record separator.
 */

const RECORD = "\u001e";

export interface ActionRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Every curl invocation's arguments, in order. */
  curl: string[][];
  /** Every gh invocation's arguments, in order, ending with the GH_TOKEN it saw as `GH_TOKEN=...`. */
  gh: string[][];
  /** What the step wrote to GITHUB_OUTPUT. */
  outputs: Record<string, string>;
}

export interface Fakes {
  /** What the fake curl answers as HTTP status to the instance call. */
  status?: string;
  /** Response body the fake curl writes for the instance call. */
  body?: string;
  /** JSON the fake `gh api` filters with the requested --jq. */
  ghJson?: string;
  /** Omit ACTIONS_ID_TOKEN_REQUEST_URL, as a job without id-token: write would. */
  noIdToken?: boolean;
  /** The fake gh exits 1 without output, as it would when GitHub is unreachable or the token is bad. */
  ghFails?: boolean;
}

const TOKEN_URL = "https://token.actions.test/oidc";

export async function runAction(name: string, inputs: Record<string, string>, fakes: Fakes = {}): Promise<ActionRun> {
  const root = new URL("../../", import.meta.url).pathname;
  const doc: unknown = Bun.YAML.parse(await Bun.file(`${root}actions/${name}/action.yml`).text());
  const step = firstStep(doc);
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/nudge-action-${name}-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${dir}/bin`.quiet();
  await writeFakes(dir);
  const outputFile = `${dir}/github-output`;
  await Bun.write(outputFile, "");
  const env: Record<string, string> = {
    ...stepEnv(step, doc, inputs),
    PATH: `${dir}/bin:${process.env["PATH"] ?? ""}`,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "Taka499/ss-assist",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
    NUDGE_LOG: `${dir}/log`,
    NUDGE_TOKEN_URL: TOKEN_URL,
    NUDGE_FAKE_STATUS: fakes.status ?? "204",
    NUDGE_FAKE_BODY: fakes.body ?? "",
    NUDGE_FAKE_GH_JSON: fakes.ghJson ?? "[]",
    NUDGE_FAKE_GH_FAIL: fakes.ghFails ? "1" : "",
  };
  if (!fakes.noIdToken) env["ACTIONS_ID_TOKEN_REQUEST_URL"] = TOKEN_URL;
  const proc = Bun.spawn(["bash", "-c", step.run], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const calls = await readLog(`${dir}/log`);
  return {
    code,
    stdout,
    stderr,
    curl: calls.filter((c) => c[0] === "curl").map((c) => c.slice(1)),
    gh: calls.filter((c) => c[0] === "gh").map((c) => c.slice(1)),
    outputs: parseOutputs(await Bun.file(outputFile).text()),
  };
}

interface Step {
  run: string;
  env: Record<string, string>;
}

function firstStep(doc: unknown): Step {
  const steps = record(record(doc)["runs"])["steps"];
  const step = record(Array.isArray(steps) ? steps[0] : undefined);
  const run = step["run"];
  if (typeof run !== "string") throw new Error("action has no run step");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(step["env"]))) if (typeof value === "string") env[key] = value;
  return { run, env };
}

/** Resolves `${{ inputs.x }}` and `${{ github.token }}` in the step's env the way the runner would. */
function stepEnv(step: Step, doc: unknown, inputs: Record<string, string>): Record<string, string> {
  const declared = record(record(doc)["inputs"]);
  const env: Record<string, string> = {};
  for (const [key, expression] of Object.entries(step.env)) {
    env[key] = expression.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
      if (path === "github.token") return "github-token";
      const name = path.replace(/^inputs\./, "");
      const fallback = record(declared[name])["default"];
      return inputs[name] ?? (typeof fallback === "string" ? fallback.replace("${{ github.token }}", "github-token") : "");
    });
  }
  return env;
}

async function writeFakes(dir: string): Promise<void> {
  const log = `printf 'curl\\0' >> "$NUDGE_LOG"; printf '%s\\0' "$@" >> "$NUDGE_LOG"; printf '${RECORD}' >> "$NUDGE_LOG"`;
  const curl = `#!/bin/bash
${log}
for a in "$@"; do case "$a" in "$NUDGE_TOKEN_URL") echo '{"value":"oidc.token"}'; exit 0;; esac; done
out=""; prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
if [ -n "$out" ]; then printf '%s' "$NUDGE_FAKE_BODY" > "$out"; fi
printf '%s' "$NUDGE_FAKE_STATUS"
`;
  const gh = `#!/bin/bash
printf 'gh\\0' >> "$NUDGE_LOG"; printf '%s\\0' "$@" >> "$NUDGE_LOG"; printf 'GH_TOKEN=%s\\0' "\${GH_TOKEN:-}" >> "$NUDGE_LOG"; printf '${RECORD}' >> "$NUDGE_LOG"
if [ -n "$NUDGE_FAKE_GH_FAIL" ]; then echo "gh: HTTP 503" >&2; exit 1; fi
filter="."; prev=""; for a in "$@"; do if [ "$prev" = "--jq" ]; then filter="$a"; fi; prev="$a"; done
jq -r "$filter" <<<"$NUDGE_FAKE_GH_JSON"
`;
  await Bun.write(`${dir}/bin/curl`, curl);
  await Bun.write(`${dir}/bin/gh`, gh);
  await Bun.$`chmod +x ${dir}/bin/curl ${dir}/bin/gh`.quiet();
}

async function readLog(path: string): Promise<string[][]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split(RECORD).filter((r) => r !== "").map((r) => r.split("\0").filter((a) => a !== ""));
}

function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}
