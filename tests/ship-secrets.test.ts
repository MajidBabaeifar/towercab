// Secret steps (SHIP-33..36): a plan lists a secret as an owner step, Towercab writes it with `sops` in a
// PR the owner approves, the step ticks itself, and the value is never seen anywhere else.

import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeEnv } from "../src/claude.ts";
import { tickSteps } from "../src/commands.ts";
import type { GitHub } from "../src/handlers.ts";
import { dataOf, getMission, insertMission } from "../src/mission.ts";
import { sandboxEnv } from "../src/pipeline/sandbox.ts";
import { parseResult } from "../src/pipeline/schemas.ts";
import { generateSecret } from "../src/ship/generate.ts";
import {
  advanceSecrets,
  approveSecret,
  mask,
  type SecretEnv,
  supplySecret,
} from "../src/ship/secret-steps.ts";
import { numbered, type OwnerStep, parseSteps, renderSteps } from "../src/steps.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, git, TestClock, tempDir, testConfig, testDb, testHome } from "./helpers/world.ts";

const INTENT = "261104-1706";
const FILE = "secrets/apps/herald.yaml";
const SESSION = {
  repo: "infra",
  file: FILE,
  key: "SESSION_SECRET",
  purpose: "signs the login cookie",
  source: "generate" as const,
};
const TOKEN = {
  ...SESSION,
  key: "PLATFORM_TOKEN",
  purpose: "posts to the platform",
  source: "supply" as const,
};

function step(
  n: number,
  secret: typeof SESSION | typeof TOKEN,
  extra: Partial<OwnerStep["secret"]> = {},
): OwnerStep {
  return {
    n,
    when: "after",
    text: `Add \`${secret.key}\` to \`${secret.file}\``,
    why: secret.purpose,
    done_at: null,
    secret: { ...secret, ...extra },
  };
}

function rig(steps: OwnerStep[], files: Record<string, string> = { [FILE]: "# sops\nexisting: ENC[x]\n" }) {
  const bare = bareRepo(files);
  const home = testHome();
  git(home.root, "clone", "-q", bare, join(home.root, "secrets", "infra"));
  const tools = new FakeTools();
  tools.present.add("sops");
  const db = testDb();
  const clock = new TestClock();
  const logs: string[] = [];
  const values: string[] = [];
  const sops = { calls: [] as { args: string[] }[], fail: false };
  const gh = { calls: [] as string[], bodies: [] as string[], state: "OPEN", branch: "" };
  tools.on("sops", (args, opts) => {
    sops.calls.push({ args });
    const value = JSON.parse(opts.input ?? '""') as string;
    values.push(value);
    // A tool that echoes what it was given in its error is the worst case for redaction.
    if (sops.fail) return failResult(`cannot encrypt ${value}: no age key`, 128);
    appendFileSync(
      join(opts.cwd!, args[2]!),
      `${(JSON.parse(args[3]!) as string[])[0]}: ENC[AES256_GCM,data:abc]\n`,
    );
    return okResult();
  });
  tools.on("gh", (args, opts) => {
    const line = args.join(" ");
    gh.calls.push(line);
    if (line.startsWith("pr list")) return okResult("");
    if (line.startsWith("pr create")) {
      gh.branch = args[args.indexOf("--head") + 1]!;
      gh.bodies.push(opts.input ?? "");
      return okResult("https://github.com/owner/infra/pull/7\n");
    }
    if (line.startsWith("pr view")) return okResult(JSON.stringify({ state: gh.state }));
    if (line.startsWith("pr merge")) {
      execFileSync("git", ["--git-dir", bare, "update-ref", "refs/heads/main", `refs/heads/${gh.branch}`]);
      gh.state = "MERGED";
      return okResult();
    }
    return failResult(`gh: not faked: ${line}`);
  });
  const github: GitHub = {
    gh: (_repo, args, opts) => tools.run("gh", args, opts),
    owner: (args, opts) => tools.run("gh", args, opts),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "towercab[bot]", id: 1, email: "bot@localhost" }),
    me: "owner",
  };
  const env: SecretEnv = {
    db,
    tools,
    github,
    config: testConfig({ repos: { infra: { github: "owner/infra" } } }),
    home,
    clock,
    log: (l) => logs.push(l),
  };
  const m = insertMission(
    db,
    { intent: INTENT, slug: "herald", repo: "infra", model: "opus", a: 4 },
    clock.now(),
  );
  db.run(
    "UPDATE missions SET stage = 'steps', step = '', waiting = 'your steps', data = ? WHERE id = ?",
    JSON.stringify({ steps }),
    m.id,
  );
  const mission = () => getMission(db, m.id)!;
  const data = () =>
    dataOf<{ steps: OwnerStep[]; secrets?: Record<string, Record<string, unknown>> }>(mission());
  const pass = () => advanceSecrets(env, mission());
  const onMain = () => git(bare, "show", `main:${FILE}`);
  return { env, db, home, tools, logs, values, sops, gh, mission, data, pass, onMain, bare };
}

test("ship: the plan lists a secret as an owner step", () => {
  const plan = {
    brief: "b",
    plan: "p",
    access: { domains: [], paths: [], tests: [] },
    e2e: null,
    owner_steps: [
      { when: "after", text: "", why: "", secret: { ...SESSION, length: 24, alphabet: "hex" } },
      { when: "after", text: "Add the token", why: "x", secret: TOKEN },
      { when: "after", text: "Run the apply", why: "the server needs it" },
    ],
  };
  const r = parseResult("plan", plan);
  if (!r.ok) throw new Error(r.why);
  const steps = numbered(r.value.owner_steps ?? []);
  expect(steps[0]!.text).toBe("Add `SESSION_SECRET` to `secrets/apps/herald.yaml`");
  expect(steps[0]!.secret).toMatchObject({ source: "generate", length: 24, alphabet: "hex" });
  expect(steps[2]!.secret).toBeUndefined();
  // plan.md carries the line and reads it back; the value is never part of it.
  const md = renderSteps(steps);
  expect(md).toContain(
    " · secret SESSION_SECRET in infra/secrets/apps/herald.yaml (generate, length 24, alphabet hex)",
  );
  expect(parseSteps(md)[0]!.secret).toEqual({
    ...SESSION,
    length: 24,
    alphabet: "hex",
    purpose: parseSteps(md)[0]!.why,
  });
  expect(parseSteps(md)[1]!.secret).toMatchObject({
    key: "PLATFORM_TOKEN",
    source: "supply",
    repo: "infra",
    file: FILE,
  });
  // A supplied secret has no length or alphabet; a bad key or path is refused.
  const bad = (secret: object) =>
    parseResult("plan", { ...plan, owner_steps: [{ when: "after", text: "t", why: "w", secret }] });
  expect(bad({ ...TOKEN, length: 8 }).ok).toBe(false);
  expect(bad({ ...SESSION, file: "../x.yaml" }).ok).toBe(false);
  expect(bad({ ...SESSION, key: "a b" }).ok).toBe(false);
  expect(bad({ ...SESSION, length: 999 }).ok).toBe(false);
});

test("ship: a secret step is not ticked by hand", () => {
  const w = rig([step(1, SESSION), { n: 2, when: "after", text: "run it", why: "", done_at: null }]);
  const now = new Date(1_793_000_000_000);
  expect(() => tickSteps(w.db, INTENT, [1], true, now)).toThrow(
    `step 1 ticks itself once SESSION_SECRET exists in ${FILE}`,
  );
  // "all" leaves the secret to Towercab.
  tickSteps(w.db, INTENT, "all", true, now);
  expect(w.data().steps.map((s) => !!s.done_at)).toEqual([false, true]);
});

test("ship: a generated secret is set with sops and the step ticks", async () => {
  const w = rig([step(1, SESSION)]);
  await w.pass();
  expect(w.sops.calls).toHaveLength(1);
  expect(w.sops.calls[0]!.args).toEqual(["set", "--value-stdin", FILE, '["SESSION_SECRET"]']);
  expect(w.data().secrets!["1"]).toMatchObject({ pr: 7, approved: false });
  // The branch holds the key; main does not until the PR is merged.
  expect(git(w.bare, "show", `${w.gh.branch}:${FILE}`)).toContain("SESSION_SECRET: ENC[");
  expect(w.onMain()).not.toContain("SESSION_SECRET");
  expect(w.gh.branch).toBe(`towercab/secret-${INTENT}-SESSION_SECRET`);
  expect(w.gh.bodies[0]).toContain("`SESSION_SECRET`");
  await w.pass();
  expect(w.gh.calls.some((c) => c.startsWith("pr merge"))).toBe(false);
  approveSecret(w.db, w.env.clock, INTENT, 1);
  await w.pass();
  expect(w.gh.calls.filter((c) => c.startsWith("pr merge"))).toHaveLength(1);
  expect(w.onMain()).toContain("SESSION_SECRET: ENC[");
  await w.pass();
  expect(w.data().steps[0]!.done_at).toBeTruthy();
  expect(w.data().secrets).toBeUndefined();
  expect(w.sops.calls).toHaveLength(1);
});

test("ship: a generated secret defaults to 43 url-safe characters", async () => {
  expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(generateSecret()).not.toBe(generateSecret());
  const w = rig([step(1, SESSION)]);
  await w.pass();
  expect(w.values[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("ship: a step sets the length and alphabet of a generated secret", async () => {
  expect(generateSecret(20, "hex")).toMatch(/^[0-9a-f]{20}$/);
  expect(generateSecret(64, "alnum")).toMatch(/^[A-Za-z0-9]{64}$/);
  expect(generateSecret(10, "urlsafe")).toMatch(/^[A-Za-z0-9_-]{10}$/);
  expect(generateSecret(12)).toMatch(/^[A-Za-z0-9_-]{12}$/);
  expect(generateSecret(null, "hex")).toMatch(/^[0-9a-f]{43}$/);
  expect(() => generateSecret(0, "hex")).toThrow("length is 1 to 256");
  expect(() => generateSecret(257, "hex")).toThrow("length is 1 to 256");
  const w = rig([step(1, SESSION, { length: 32, alphabet: "hex" })]);
  await w.pass();
  expect(w.values[0]).toMatch(/^[0-9a-f]{32}$/);
});

test("ship: a secret PR waits for the owner's approval", async () => {
  const w = rig([step(1, SESSION)]);
  await w.pass();
  for (let i = 0; i < 3; i++) await w.pass();
  expect(w.gh.calls.filter((c) => c.startsWith("pr merge"))).toHaveLength(0);
  expect(w.data().secrets!["1"]!.approved).toBe(false);
  expect(() => approveSecret(w.db, w.env.clock, INTENT, 9)).toThrow("step 9 isn't one of");
  expect(approveSecret(w.db, w.env.clock, INTENT, 1)).toContain("Approved");
  expect(w.data().secrets!["1"]!.approved).toBe(true);
});

test("ship: a secret PR closed unmerged clears the card", async () => {
  const w = rig([step(1, SESSION)]);
  await w.pass();
  w.gh.state = "CLOSED";
  await w.pass();
  expect(w.data().secrets).toBeUndefined();
  // The next pass starts over with a new PR.
  w.gh.state = "OPEN";
  await w.pass();
  expect(w.data().secrets!["1"]).toMatchObject({ pr: 7 });
  expect(w.sops.calls).toHaveLength(2);
});

test("ship: an existing key is not overwritten", async () => {
  const w = rig([step(1, SESSION)], { [FILE]: "# sops\nSESSION_SECRET: ENC[old]\n" });
  await w.pass();
  expect(w.sops.calls).toHaveLength(0);
  expect(w.gh.calls.filter((c) => c.startsWith("pr create"))).toHaveLength(0);
  expect(w.data().steps[0]!.done_at).toBeTruthy();
  expect(w.onMain()).toBe("# sops\nSESSION_SECRET: ENC[old]\n");
});

test("ship: a failed secret write is retried then held", async () => {
  const w = rig([step(1, SESSION)]);
  w.sops.fail = true;
  for (let i = 0; i < 5; i++) await w.pass();
  // Three tries, then it stops until the owner asks again.
  expect(w.sops.calls).toHaveLength(3);
  expect(w.data().secrets!["1"]).toMatchObject({ fails: 3 });
  expect(w.logs.some((l) => l.includes("not trying again until you do"))).toBe(true);
  w.sops.fail = false;
  expect(approveSecret(w.db, w.env.clock, INTENT, 1)).toContain("again");
  await w.pass();
  expect(w.data().secrets!["1"]).toMatchObject({ pr: 7 });
});

test("ship: a supplied secret typed in the UI is set and the step ticks", async () => {
  const w = rig([step(1, TOKEN)]);
  // Nothing is made up for a supplied secret.
  await w.pass();
  expect(w.sops.calls).toHaveLength(0);
  const said = await supplySecret(w.env, INTENT, 1, "tok_live_9f8e7d\n");
  expect(said).not.toContain("tok_live_9f8e7d");
  expect(w.values).toEqual(["tok_live_9f8e7d"]);
  expect(w.data().secrets!["1"]).toMatchObject({ pr: 7, approved: false });
  approveSecret(w.db, w.env.clock, INTENT, 1);
  await w.pass();
  expect(w.onMain()).toContain("PLATFORM_TOKEN: ENC[");
  await w.pass();
  expect(w.data().steps[0]!.done_at).toBeTruthy();
});

test("ship: a supplied secret is refused when empty or too long", async () => {
  const w = rig([step(1, TOKEN)]);
  await expect(supplySecret(w.env, INTENT, 1, "")).rejects.toThrow("PLATFORM_TOKEN needs a value");
  await expect(supplySecret(w.env, INTENT, 1, "\r\n")).rejects.toThrow("PLATFORM_TOKEN needs a value");
  await expect(supplySecret(w.env, INTENT, 1, "x".repeat(8193))).rejects.toThrow(
    "PLATFORM_TOKEN is too long",
  );
  await supplySecret(w.env, INTENT, 1, "x".repeat(8192));
  expect(w.sops.calls).toHaveLength(1);
});

test("ship: a generate step has no secret field", async () => {
  const w = rig([step(1, SESSION), { n: 2, when: "after", text: "run it", why: "", done_at: null }]);
  await expect(supplySecret(w.env, INTENT, 1, "abc12345")).rejects.toThrow("step 1 has no secret field");
  await expect(supplySecret(w.env, INTENT, 2, "abc12345")).rejects.toThrow("step 2 has no secret field");
  expect(w.sops.calls).toHaveLength(0);
});

function everyText(w: ReturnType<typeof rig>): string {
  const parts: string[] = [w.logs.join("\n"), w.gh.bodies.join("\n"), w.gh.calls.join("\n")];
  for (const c of w.tools.calls) parts.push(`${c.cmd} ${c.args.join(" ")}`);
  for (const t of ["missions", "transitions", "commands", "meta"])
    parts.push(JSON.stringify(w.db.all(`SELECT * FROM ${t}`)));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(w.home.root);
  return parts.join("\n");
}

test("ship: a secret value is absent from every log line, PR body and run record", async () => {
  const w = rig([step(1, SESSION), step(2, TOKEN)]);
  // A failing write that echoes the value, then a good one for both kinds.
  w.sops.fail = true;
  await w.pass();
  w.sops.fail = false;
  approveSecret(w.db, w.env.clock, INTENT, 1);
  for (let i = 0; i < 4; i++) {
    await w.pass();
    if (i === 0) approveSecret(w.db, w.env.clock, INTENT, 1);
  }
  w.gh.state = "OPEN";
  await supplySecret(w.env, INTENT, 2, "tok_live_9f8e7d");
  approveSecret(w.db, w.env.clock, INTENT, 2);
  for (let i = 0; i < 3; i++) await w.pass();
  expect(w.values.length).toBeGreaterThanOrEqual(3);
  expect(w.data().steps.every((s) => s.done_at)).toBe(true);
  const text = everyText(w);
  expect(text.length).toBeGreaterThan(100);
  for (const v of new Set(w.values)) expect(text).not.toContain(v);
  // The failure was recorded without the value.
  expect(text).toContain("cannot encrypt [redacted]");
});

test("ship: the worker environment carries no age key", () => {
  const cache = {
    SOPS_AGE_KEY: "AGE-SECRET-KEY-1ABC",
    SOPS_AGE_KEY_FILE: "/home/me/.config/sops/age/keys.txt",
    XDG_CACHE_HOME: "/c",
  };
  const config = testConfig();
  const env = sandboxEnv("/home/me", config, cache);
  expect(Object.keys(env).filter((k) => /SOPS|AGE/i.test(k))).toEqual([]);
  expect(env.XDG_CACHE_HOME).toBe("/c");
  const run = { config, cacheEnv: cache } as unknown as Parameters<typeof claudeEnv>[0];
  expect(Object.keys(claudeEnv(run, "/home/me")).filter((k) => /SOPS|AGE/i.test(k))).toEqual([]);
});

test("ship: sops output is redacted", async () => {
  expect(mask("failed with tok_9f8e inside", "tok_9f8e")).toBe("failed with [redacted] inside");
  expect(mask('quoted "a\\"b"', 'a"b')).toBe('quoted "[redacted]"');
  const w = rig([step(1, TOKEN)]);
  w.sops.fail = true;
  const err = await supplySecret(w.env, INTENT, 1, "tok_live_9f8e7d").catch((e: Error) => e.message);
  expect(err).toContain("cannot encrypt [redacted]");
  expect(err).not.toContain("tok_live_9f8e7d");
  expect(w.logs.join("\n")).not.toContain("tok_live_9f8e7d");
  writeFileSync(join(tempDir(), "x"), "");
});
