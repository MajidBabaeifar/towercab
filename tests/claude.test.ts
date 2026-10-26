// Claude runs (PIP-24, PIP-13): argv of every kind, settings by autonomy, the environment, the result.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  type ClaudeRun,
  claudeArgv,
  claudeEnv,
  claudeSettings,
  freshContext,
  parseRun,
  prepareRun,
  type RunKind,
  runEndLine,
} from "../src/claude.ts";
import { grantsFor } from "../src/pipeline/access.ts";
import { cacheEnv } from "../src/pipeline/sandbox.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const U = "6f1c1b7e-3f61-4d7c-9a7a-2b1f0c9d8e01";
const config = testConfig({ agent: { path: "/usr/bin:/bin" } }, "/cfg/config.toml");
const O = { towercabExe: "/opt/towercab/bin/towercab", home: "/home/me" };

function run(kind: RunKind, over: Partial<ClaudeRun> = {}): ClaudeRun {
  return {
    kind,
    model: "opus",
    cwd: "/h/work/261001-0900-1",
    runsDir: "/h/runs/261001-0900",
    n: 1,
    prompt: "do it",
    session: { mode: "none", id: "" },
    claudeMd: "# Base rules\n",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config,
    ...over,
  };
}

/** The flags every run starts with. */
function common(kind: string, model = "opus"): string[] {
  return [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--append-system-prompt-file",
    `/h/runs/261001-0900/system-${kind}.md`,
    "--settings",
    `/h/runs/261001-0900/settings-${kind}.json`,
    "--model",
    model,
  ];
}

const DENY = [
  "Bash(git push:*)",
  "Bash(git remote:*)",
  "Bash(git config:*)",
  "Bash(gh:*)",
  "Bash(ssh:*)",
  "Bash(sudo:*)",
  "Read(~/.ssh/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.config/towercab/**)",
  "Read(~/.claude/.credentials.json)",
  "Read(~/.netrc)",
  "Read(~/.git-credentials)",
  // Towercab's own config and App key, wherever --config put them.
  "Read(//cfg/config.toml)",
  "Read(//cfg/app.pem)",
];

test("claude: worker argv", () => {
  const r = run("worker", { session: { mode: "resume", id: U }, budgetUsd: 5, schema: { type: "object" } });
  expect(claudeArgv(r)).toEqual([
    ...common("worker"),
    "--tools",
    "Read,Edit,Write,Glob,Grep,Bash,WebFetch",
    "--allowedTools",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash",
    "--disallowedTools",
    ...DENY,
    "--resume",
    U,
    "--max-budget-usd",
    "5",
    "--json-schema",
    '{"type":"object"}',
  ]);
  // Design starts the session with --session-id and may edit only specs/.
  const d = claudeArgv(run("design", { session: { mode: "new", id: U } }));
  expect(d.slice(15, 22)).toEqual([
    "--tools",
    "Read,Glob,Grep,Edit,Write",
    "--allowedTools",
    "Read",
    "Glob",
    "Grep",
    "Edit(specs/**)",
  ]);
  expect(d.slice(-2)).toEqual(["--session-id", U]);
  // Plan: read-only git and ls.
  expect(claudeArgv(run("plan"))).toContain("Bash(ls:*)");
  expect(claudeArgv(run("plan"))).not.toContain("Edit");

  // The child and its files: the checkout, prompt on stdin, the guard written.
  const root = tempDir();
  const checkout = join(root, "work");
  mkdirSync(join(checkout, ".github"), { recursive: true });
  writeFileSync(join(checkout, "CLAUDE.md"), "x");
  const runsDir = join(root, "runs");
  const w = run("worker", {
    cwd: checkout,
    runsDir,
    session: { mode: "resume", id: U },
    guardRules: {
      checkout,
      protected: ["CLAUDE.md", ".github/**"],
      granted: [],
      locked: ["tests/a.test.ts"],
    },
    cache: join(root, "cache"),
  });
  const spec = prepareRun(w, O);
  expect(spec).toMatchObject({
    kind: "worker",
    cwd: checkout,
    stdin: join(runsDir, "worker-1.prompt"),
    stdout: join(runsDir, "worker-1.json"),
    stderr: join(runsDir, "worker-1.err"),
    timeoutMs: 60 * 60_000,
    slot: true,
    model: "opus",
  });
  expect(readFileSync(join(runsDir, "worker-1.prompt"), "utf8")).toBe("do it");
  expect(JSON.parse(readFileSync(join(runsDir, "guard.json"), "utf8"))).toMatchObject({
    checkout,
    granted: [],
    locked: ["tests/a.test.ts"],
  });
  const s = JSON.parse(readFileSync(join(runsDir, "settings-worker.json"), "utf8"));
  expect(s.hooks).toEqual({
    PreToolUse: [
      {
        matcher: "Edit|Write|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: `'/opt/towercab/bin/towercab' hook guard '${join(runsDir, "guard.json")}'`,
          },
        ],
      },
    ],
  });
  expect(s.sandbox.filesystem.denyWrite).toEqual([
    join(checkout, ".git"),
    join(checkout, ".github"),
    join(checkout, "CLAUDE.md"),
    join(checkout, "tests/a.test.ts"),
  ]);
  expect(s.sandbox.filesystem.allowWrite).toEqual([join(root, "cache")]);
  // Never the repo's own settings: none are loaded, and only Towercab's hook is set.
  expect(spec.argv[spec.argv.indexOf("--setting-sources") + 1]).toBe("");
});

test("claude: review argv", () => {
  const r = run("review", { model: "sonnet", session: { mode: "new", id: U }, budgetUsd: null });
  expect(claudeArgv(r)).toEqual([
    ...common("review", "sonnet"),
    "--tools",
    "Read,Glob,Grep,Bash",
    "--allowedTools",
    "Read",
    "Glob",
    "Grep",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "--disallowedTools",
    ...DENY,
    "--session-id",
    U,
  ]);
  const root = tempDir();
  const spec = prepareRun({ ...r, runsDir: join(root, "runs"), cwd: root }, O);
  expect(spec.timeoutMs).toBe(15 * 60_000);
  // No guard for the review: no hook, only its .git unwritable, no network.
  const s = JSON.parse(readFileSync(join(root, "runs", "settings-review.json"), "utf8"));
  expect(s.hooks).toBeUndefined();
  expect(s.sandbox).toEqual({
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: [
        "/home/me/.ssh",
        "/home/me/.config/gh",
        "/home/me/.aws",
        "/home/me/.gnupg",
        "/home/me/.config/towercab",
        "/home/me/.claude/.credentials.json",
        "/home/me/.netrc",
        "/home/me/.git-credentials",
        "/cfg/config.toml",
        "/cfg/app.pem",
      ],
      denyWrite: [join(root, ".git")],
    },
  });
});

test("claude: settings by autonomy", () => {
  const defaults = ["registry.npmjs.org", "*.npmjs.org"];
  const plan = {
    domains: [{ domain: "api.stripe.com", why: "docs" }],
    paths: [{ glob: ".github/**", why: "ci" }],
  };
  const at = (a: number) =>
    grantsFor({ a, source: "me", plan, unlock: [], network: [], defaults, unplanned: null });
  const root = tempDir();
  const checkout = join(root, "c");
  mkdirSync(join(checkout, ".github"), { recursive: true });
  mkdirSync(join(checkout, ".claude"), { recursive: true });
  const settings = (a: number) => {
    const g = at(a);
    return claudeSettings(
      run("worker", {
        cwd: checkout,
        grants: g,
        guardRules: { checkout, protected: [], granted: g.paths, locked: [] },
      }),
      O,
    ) as {
      sandbox: { network?: { allowedDomains: string[] }; filesystem: { denyWrite: string[] } };
      permissions?: { allow: string[] };
    };
  };
  // a3: the list and the plan's domains; every protected path writable but .git.
  const a3 = settings(3);
  expect(a3.sandbox.network).toEqual({ allowedDomains: [...defaults, "api.stripe.com"] });
  expect(a3.permissions?.allow).toEqual([
    "WebFetch(domain:registry.npmjs.org)",
    "WebFetch(domain:*.npmjs.org)",
    "WebFetch(domain:api.stripe.com)",
  ]);
  expect(a3.sandbox.filesystem.denyWrite).toEqual([join(checkout, ".git")]);
  // a4: only the planned protected paths.
  expect(settings(4).sandbox.filesystem.denyWrite).toEqual([
    join(checkout, ".git"),
    join(checkout, ".claude"),
  ]);
  // a5: any domain for WebFetch.
  expect(settings(5).permissions?.allow).toContain("WebFetch(domain:*)");
  expect(settings(4).permissions?.allow).not.toContain("WebFetch(domain:*)");
  // Unix sockets allowed: the host's sockets hidden.
  const sock = testConfig({ agent: { sandbox_unix_sockets: true } }, "/cfg/config.toml");
  const s = claudeSettings(run("worker", { config: sock }), O) as {
    sandbox: { network: Record<string, unknown>; filesystem: { denyRead: string[] } };
  };
  expect(s.sandbox.network).toEqual({ allowAllUnixSockets: true });
  expect(s.sandbox.filesystem.denyRead).toContain("/run/user");
});

function result(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    result: "done",
    session_id: U,
    total_cost_usd: 0.42,
    permission_denials: [],
    ...extra,
  });
}
const NOW = new Date("2026-10-15T13:30:00+02:00");
const parse = (stdout: string, stderr: string, exit: number | null) =>
  parseRun(stdout, stderr, exit, { model: "opus", now: NOW, zone: "Europe/Berlin", home: "/home/me" });

test("claude: result parse", () => {
  const full = result({
    modelUsage: {
      "claude-opus-4-1": {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
        costUSD: 0.4,
      },
    },
    structured_output: { status: "done" },
  });
  const ok = parse(`{"type":"system","subtype":"init"}\nnot json\n${full}\n`, "", 0);
  expect(ok).toEqual({
    kind: "ok",
    result: {
      subtype: "success",
      isError: false,
      result: "done",
      sessionId: U,
      costUsd: 0.42,
      durationMs: 1200,
      structuredOutput: { status: "done" },
      permissionDenials: [],
      modelUsage: {
        "claude-opus-4-1": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          costUsd: 0.4,
        },
      },
    },
  });
  // A pretty-printed result reads too.
  expect(parse(JSON.stringify(JSON.parse(full), null, 2), "", 0).kind).toBe("ok");

  // First match wins: session gone > limit > env > budget > denied > no result > failed.
  expect(parse(full, "No conversation found with session ID: x", 1)).toEqual({ kind: "sessionGone" });
  const limit = parse(
    result({ is_error: true, result: "You've hit your limit · resets 3pm (Europe/Berlin)" }),
    "",
    1,
  );
  expect(limit.kind === "limit" && [limit.limit.model, limit.limit.reset?.toISOString()]).toEqual([
    "opus",
    "2026-10-15T13:00:00.000Z",
  ]);
  expect(parse("", "API Error: Connection error: ECONNREFUSED", 1)).toEqual({
    kind: "env",
    fault: "network",
    text: "API Error: Connection error: ECONNREFUSED",
  });
  expect(parse("", "Invalid API key · Please run /login", 1)).toMatchObject({ kind: "env", fault: "auth" });
  expect(parse(result({ subtype: "error_max_budget_usd", is_error: true, result: "" }), "", 1).kind).toBe(
    "budget",
  );
  expect(parse("", "", 1)).toEqual({ kind: "noResult", why: "no result" });
  expect(parse("garbage", "boom", 1)).toEqual({
    kind: "noResult",
    why: "no JSON result: garbage; stderr: boom",
  });
  expect(parse("", "", null)).toEqual({ kind: "noResult", why: "no result" });
  expect(
    parse(result({ is_error: true, subtype: "error_during_execution", result: "" }), "", 1),
  ).toMatchObject({
    kind: "failed",
    why: "error_during_execution",
  });
  expect(parse(result({ is_error: true, result: "it broke" }), "", 0)).toMatchObject({
    kind: "failed",
    why: "it broke",
  });
  expect(runEndLine({ kind: "failed", why: "it broke", result: null })).toBe("failed: it broke");
  // A successful result that mentions a network word is no failure.
  expect(parse(result({ result: "fixed the connection refused test" }), "", 0).kind).toBe("ok");

  // A denied push or secret read fails the step; other denials don't.
  const denied = (tool: string, input: Record<string, unknown>) =>
    parse(result({ permission_denials: [{ tool_name: tool, tool_use_id: "t1", tool_input: input }] }), "", 0);
  for (const cmd of ["git push origin HEAD", "cd x && git push", "git -C . push -f"]) {
    expect(denied("Bash", { command: cmd }).kind, cmd).toBe("denied");
  }
  expect(denied("Bash", { command: "git pushd-helper" }).kind).toBe("ok");
  expect(denied("Bash", { command: "rm -rf target" }).kind).toBe("ok");
  expect(denied("Read", { file_path: "/home/me/.ssh/id_ed25519" })).toMatchObject({
    kind: "denied",
    what: "a read of ~/.ssh",
  });
  expect(denied("Bash", { command: "cat ~/.config/gh/hosts.yml" }).kind).toBe("denied");
  expect(denied("Read", { file_path: "/repo/src/main.ts" }).kind).toBe("ok");

  // The prompt of a new session replacing a gone one.
  expect(freshContext("towercab/1-x", null, "intents/1-x/intent.md", ["PIP-4"], null)).toBe(
    [
      "Your earlier session is gone; continue the work from the repo.",
      "Branch: towercab/1-x",
      "PR: none yet",
      "Intent: intents/1-x/intent.md",
      "Spec IDs: PIP-4",
      "Plan: none yet",
      "Read them, check what is done with git log and git diff, then go on.",
    ].join("\n"),
  );
});

test("claude: no token in env", () => {
  // Even when the owner's config or the repo's env names one, no GitHub token reaches a run.
  const c = testConfig(
    {
      agent: { path: "/usr/bin:/bin", env: { GH_TOKEN: "ghs_app", CRATE_CC_NO_DEFAULTS: "1" } },
      repos: { web: { github: "owner/web", env: { GITHUB_TOKEN: "mine" } } },
    },
    "/cfg/config.toml",
  );
  const cache = cacheEnv("/h/cache/web", c, c.repos.get("web")!);
  const env = claudeEnv(run("worker", { config: c, cacheEnv: cache }), "/home/me");
  expect(Object.keys(env)).toEqual([
    "HOME",
    "PATH",
    "LANG",
    "XDG_CACHE_HOME",
    "npm_config_cache",
    "CARGO_HOME",
    "CARGO_TARGET_DIR",
    "GOCACHE",
    "PIP_CACHE_DIR",
    "CRATE_CC_NO_DEFAULTS",
  ]);
  expect(env).toMatchObject({ HOME: "/home/me", PATH: "/usr/bin:/bin" });
  expect(JSON.stringify(env)).not.toMatch(/ghs_app|mine/);
});
