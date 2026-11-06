// Agent files (PIP-70..78): `agents/<name>.md` is the one place a Claude run is configured.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AGENT_NAMES,
  AGENTS_DIR,
  agentBudgetUsd,
  agentTimeoutMin,
  KNOWN_TOOLS,
  loadAgent,
  parseAgent,
} from "../src/agents.ts";
import { type ClaudeRun, disallowed, prepareRun } from "../src/claude.ts";
import { AGENT_VARS, render } from "../src/pipeline/prompts.ts";
import { SCHEMAS } from "../src/pipeline/schemas.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const GOOD = [
  "---",
  "tools: [Read, Bash]",
  'allow: [Read, "Bash(ls:*)"]',
  "sandbox: strict",
  "model: mission",
  "session: resume",
  "timeout_min: 30",
  "max_cost_usd: 4",
  "schema: plan",
  "---",
  "Hello {{intent}}",
  "",
].join("\n");

/** The tools and allowed rules each agent had in the `KINDS` table before the agent files (PIP-77). */
const BEFORE: Record<string, { tools: string; allowed: string[] }> = {
  design: { tools: "Read,Glob,Grep,Edit,Write", allowed: ["Read", "Glob", "Grep", "Edit(specs/**)"] },
  plan: {
    tools: "Read,Glob,Grep,Bash",
    allowed: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      "Bash(ls:*)",
    ],
  },
  worker: {
    tools: "Read,Edit,Write,Glob,Grep,Bash,WebFetch",
    allowed: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  },
  review: {
    tools: "Read,Glob,Grep,Bash",
    allowed: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"],
  },
  score: { tools: "", allowed: [] },
  features: { tools: "Read,Glob,Grep", allowed: ["Read", "Glob", "Grep"] },
  // SHD-5: the shadow has no tools at all; Towercab runs its reads and actions.
  shadow: { tools: "", allowed: [] },
};
BEFORE.repair = BEFORE.worker!;
// PIP-96: the risk agent reads exactly as the review does, no more.
BEFORE.risk = BEFORE.review!;
// PIP-169: the merge review reads exactly as the review does, no more.
BEFORE["merge-review"] = BEFORE.review!;

test("agents: every agent has a file", () => {
  const files = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
  expect(files).toEqual([...AGENT_NAMES].sort());
  for (const n of AGENT_NAMES) expect(loadAgent(n).name).toBe(n);
  // The old per-stage prompts are gone; only the writing guide stays.
  expect(readdirSync(join(AGENTS_DIR, "..", "prompts"))).toEqual(["writing.md"]);
});

test("agents: claude.ts has no per-kind table", () => {
  const src = readFileSync(join(AGENTS_DIR, "..", "src", "claude.ts"), "utf8");
  expect(src).not.toMatch(/\bKINDS\b/);
  expect(src).not.toMatch(/SCORE_TIMEOUT_MIN/);
  expect(src).not.toMatch(/reviewTimeoutMin|buildTimeoutMin/);
});

test("agents: front matter parses", () => {
  const a = parseAgent("x", GOOD);
  expect(a).toEqual({
    name: "x",
    tools: ["Read", "Bash"],
    allow: ["Read", "Bash(ls:*)"],
    sandbox: "strict",
    model: "mission",
    session: "resume",
    timeoutMin: 30,
    maxCostUsd: 4,
    schema: "plan",
    prompt: "Hello {{intent}}\n",
  });
  const none = parseAgent(
    "y",
    GOOD.replace("tools: [Read, Bash]", "tools: []")
      .replace(/allow: .*/, "allow: []")
      .replace("sandbox: strict", "sandbox: none")
      .replace("max_cost_usd: 4", "max_cost_usd: null")
      .replace("schema: plan", "schema: null"),
  );
  expect(none.tools).toEqual([]);
  expect(none.maxCostUsd).toBeNull();
  expect(none.schema).toBeNull();
});

test("agents: unknown or missing key is refused", () => {
  expect(() => parseAgent("x", GOOD.replace("---\nHello", "extra: 1\n---\nHello"))).toThrow(
    /agents\/x\.md: unknown key extra/,
  );
  expect(() => parseAgent("x", GOOD.replace("session: resume\n", ""))).toThrow(
    /agents\/x\.md: missing key session/,
  );
  expect(() => parseAgent("x", GOOD.replace("timeout_min: 30", "timeout_min: soon"))).toThrow(
    /agents\/x\.md: timeout_min/,
  );
  expect(() => parseAgent("x", GOOD.replace("model: mission", "model: gpt"))).toThrow(/agents\/x\.md: model/);
  expect(() => parseAgent("x", "no front matter")).toThrow(/agents\/x\.md: no front matter/);
});

test("agents: config can lower a limit but not raise it", () => {
  const a = parseAgent("x", GOOD);
  const cfg = (agent: Record<string, unknown>) => testConfig({ agent });
  expect(agentTimeoutMin(a, cfg({ build_timeout: 10 }))).toBe(10);
  expect(agentTimeoutMin(a, cfg({ build_timeout: 120 }))).toBe(30);
  expect(agentBudgetUsd(a, cfg({ max_budget_usd: 2 }))).toBe(2);
  expect(agentBudgetUsd(a, cfg({ max_budget_usd: 20 }))).toBe(4);
  const review = parseAgent(
    "r",
    GOOD.replace("model: mission", "model: review").replace("max_cost_usd: 4", "max_cost_usd: null"),
  );
  expect(agentTimeoutMin(review, cfg({ review_timeout: 5, build_timeout: 100 }))).toBe(5);
  expect(agentBudgetUsd(review, cfg({}))).toBeNull();
});

test("agents: tools and permissions parse", () => {
  for (const n of AGENT_NAMES) {
    const a = loadAgent(n);
    for (const t of a.tools) expect(KNOWN_TOOLS, `${n}: ${t}`).toContain(t);
    for (const r of a.allow) {
      const m = /^([A-Za-z]+)(?:\((.+)\))?$/.exec(r);
      expect(m, `${n}: ${r}`).not.toBeNull();
      expect(a.tools, `${n}: ${r}`).toContain(m![1]);
    }
  }
  expect(() => parseAgent("x", GOOD.replace("tools: [Read, Bash]", "tools: [Read, Fly]"))).toThrow(
    /unknown tool Fly/,
  );
  expect(() => parseAgent("x", GOOD.replace('"Bash(ls:*)"', '"Edit(x)"'))).toThrow(
    /names a tool the agent doesn't have/,
  );
  expect(() => parseAgent("x", GOOD.replace('"Bash(ls:*)"', '"Bash(("'))).toThrow(/allow rule/);
});

test("agents: schema exists", () => {
  for (const n of AGENT_NAMES) {
    const s = loadAgent(n).schema;
    expect(s, n).not.toBeNull();
    expect(Object.keys(SCHEMAS), n).toContain(s);
  }
  expect(() => parseAgent("x", GOOD.replace("schema: plan", "schema: nope"))).toThrow(
    /agents\/x\.md: schema/,
  );
});

test("agents: prompt fills without an unknown placeholder", () => {
  for (const n of AGENT_NAMES) {
    const used = new Set([...loadAgent(n).prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
    for (const key of used) expect(AGENT_VARS[n], `${n} uses {{${key}}}`).toContain(key);
    const vars = Object.fromEntries(AGENT_VARS[n].map((k) => [k, `<${k}>`]));
    expect(render(n, vars), n).not.toMatch(/\{\{\w+\}\}/);
  }
  expect(() => render("plan", {})).toThrow(/agents\/plan\.md uses \{\{intent\}\}/);
});

test("agents: allow does not overlap disallowed", () => {
  const deny = disallowed(testConfig());
  const denied = deny.filter((d) => d.startsWith("Bash(")).map((d) => d.slice(5, -3));
  for (const n of AGENT_NAMES) {
    for (const r of loadAgent(n).allow) {
      expect(deny, `${n}: ${r}`).not.toContain(r);
      // A narrow Bash rule must not grant a command the disallowed list forbids.
      const m = /^Bash\((.+):\*\)$/.exec(r);
      if (m)
        for (const d of denied) expect(m[1]!.startsWith(d) || d.startsWith(m[1]!), `${n}: ${r}`).toBe(false);
    }
  }
});

test("agents: repair continues the worker session", () => {
  const repair = loadAgent("repair");
  const worker = loadAgent("worker");
  expect(repair.session).toBe("resume");
  expect(repair.schema).toBe("build");
  expect(repair.tools).toEqual(worker.tools);
  expect(repair.allow).toEqual(worker.allow);
  expect(repair.prompt).toContain("{{what}}");
});

test("agents: score has no tools", () => {
  const s = loadAgent("score");
  expect(s.tools).toEqual([]);
  expect(s.allow).toEqual([]);
  expect(s.session).toBe("none");
  expect(s.timeoutMin).toBe(5);
});

test("agents: review has a cost cap", () => {
  const r = loadAgent("review");
  expect(r.maxCostUsd).toBe(3);
  // `[agent].max_budget_usd` can only lower it.
  expect(agentBudgetUsd(r, { ...testConfig(), agent: { ...testConfig().agent, maxBudgetUsd: 2 } })).toBe(2);
  expect(agentBudgetUsd(r, { ...testConfig(), agent: { ...testConfig().agent, maxBudgetUsd: 10 } })).toBe(3);
});

test("agents: spec table lists every agent", () => {
  const spec = readFileSync(join(AGENTS_DIR, "..", "specs", "pipeline.md"), "utf8");
  const linked = [...spec.matchAll(/^\|\s*\[[^\]]+\]\(\.\.\/agents\/([\w-]+)\.md\)/gm)]
    .map((m) => m[1]!)
    .sort();
  expect(linked).toEqual([...AGENT_NAMES].sort());
  for (const n of linked) expect(existsSync(join(AGENTS_DIR, `${n}.md`))).toBe(true);
});

test("agents: no agent has more than the previous table allowed", () => {
  for (const n of AGENT_NAMES) {
    const a = loadAgent(n);
    const before = BEFORE[n]!;
    const beforeTools = before.tools ? before.tools.split(",") : [];
    for (const t of a.tools) expect(beforeTools, `${n}: tool ${t}`).toContain(t);
    for (const r of a.allow) expect(before.allowed, `${n}: ${r}`).toContain(r);
  }
});

test("agents: a tool-using agent cannot disable the sandbox", () => {
  for (const n of AGENT_NAMES) {
    const a = loadAgent(n);
    if (a.tools.length) expect(a.sandbox, n).toBe("strict");
  }
  expect(() => parseAgent("x", GOOD.replace("sandbox: strict", "sandbox: none"))).toThrow(
    /sandbox may be none only for an agent with no tools/,
  );
});

test("agents: the sandbox settings do not come from the file", () => {
  const root = tempDir();
  const run: ClaudeRun = {
    kind: "score",
    model: "opus",
    cwd: root,
    runsDir: join(root, "runs"),
    n: 1,
    prompt: "x",
    session: { mode: "none", id: "" },
    claudeMd: "",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: testConfig(),
  };
  const spec = prepareRun(run, { towercabExe: "towercab", home: "/home/me" });
  // `sandbox: none` in score.md, yet the run's settings still confine it.
  expect(loadAgent("score").sandbox).toBe("none");
  const settings = JSON.parse(readFileSync(spec.argv[spec.argv.indexOf("--settings") + 1]!, "utf8"));
  expect(settings.sandbox.enabled).toBe(true);
  expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
});
