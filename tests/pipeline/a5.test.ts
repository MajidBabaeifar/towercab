// One a5 intent through the real pipeline (PIP-1..5, 13, 22, 23, 25, 28, 30, 40, 49..51, MET-28),
// shared by the tests below: each checks one requirement on what the flow did.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import {
  BUILD_BRIEF,
  build,
  CODE,
  DESIGN,
  ID,
  intent,
  intents,
  PLAN,
  REVIEW,
  reply,
  SLUG,
  SPEC,
  WORKER_PR,
} from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const CLAUDE_MD = `# Web

## Verifying your work

\`\`\`setup
sh -c 'echo set up > .setup-ran'
\`\`\`

\`\`\`checks
sh -c 'for t in tests/*.sh; do sh "$t" || exit 1; done'
\`\`\`

\`\`\`screenshots
sh -c 'printf png > "$TOWERCAB_SHOTS/home.png"'
\`\`\`
`;

let p: Pipe;
let m: Mission;
let seed: string;

beforeAll(async () => {
  p = new Pipe(
    { "CLAUDE.md": CLAUDE_MD, "tests/base.sh": "true\n", "README.md": "web\n", ".gitignore": ".setup-ran\n" },
    intents(intent({ a: 5, extra: "model: sonnet\n" })),
    { keep: true },
  );
  seed = git(p.bares.web!, "rev-parse", "main").trim();
  // Session totals grow on each resume (MET-28); the review is its own session.
  p.script(
    // The design also touches a file outside specs/: only specs/ may reach the spec PR.
    reply(DESIGN, { ...SPEC, "README.md": "edited by the design run\n" }, { cost: 0.4, durationMs: 10_000 }),
    reply(PLAN, undefined, { cost: 0.9, durationMs: 20_000 }),
    reply(build(), CODE, { cost: 1.5, durationMs: 30_000 }),
    reply(REVIEW, undefined, { cost: 0.3, durationMs: 40_000 }),
  );
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  await p.loop.pass();
  m = p.mission()!;
}, 60_000);

afterAll(() => p.cleanup());

const call = (kind: string) => p.claudeCalls.find((c) => c.kind === kind)!;
const spec = () => p.prs[0]!;
const plan = () => p.prs[1]!;
const code = () => p.prs[2]!;

test("pipeline: design edits only specs", () => {
  expect(m.stage, p.moves()).toBe("done");
  const d = call("design").argv;
  expect(d.slice(d.indexOf("--tools"), d.indexOf("--tools") + 2)).toEqual([
    "--tools",
    "Read,Glob,Grep,Edit,Write",
  ]);
  const allowed = d.slice(d.indexOf("--allowedTools") + 1, d.indexOf("--disallowedTools"));
  expect(allowed).toEqual(["Read", "Glob", "Grep", "Edit(specs/**)"]);
  // The spec PR's commit holds only specs/, and the design's stray edit never reaches the code PR.
  const branch = `towercab/${ID}-${SLUG}-spec`;
  expect(git(p.bares.web!, "diff", "--name-only", seed, branch).trim()).toBe("specs/web.md");
  expect(p.show("web", "main", "README.md")).toBe("web\n");
});

test("pipeline: spec PR is opened", () => {
  expect(spec()).toMatchObject({
    repo: "owner/web",
    head: `towercab/${ID}-${SLUG}-spec`,
    base: "main",
    title: "docs(specs): Show a greeting",
  });
  expect(spec().body).toContain("The page will greet visitors.");
  expect(spec().body).toContain("**Spec IDs:** WEB-1");
  expect(p.show("web", "main", "specs/web.md")).toBe(SPEC["specs/web.md"]);
  expect(m.spec_pr).toBe(spec().number);
});

test("pipeline: spec PR merged when the gate is open", () => {
  // a5, no concerns: Towercab merged it itself after its (absent) CI, and moved on to plan.
  expect(spec().state).toBe("MERGED");
  expect(
    p.tools
      .lines("gh")
      .some((l) => l.startsWith(`pr merge ${spec().number} -R owner/web --squash --match-head-commit `)),
  ).toBe(true);
  const moves = p.db.all<{ event: string; to_stage: string }>(
    "SELECT event, to_stage FROM transitions WHERE mission = ? ORDER BY id",
    m.id,
  );
  expect(moves.slice(0, 3)).toEqual([
    { event: "ok", to_stage: "design" },
    { event: "spec_merged", to_stage: "plan" },
    { event: "plan_merged", to_stage: "build" },
  ]);
});

test("pipeline: plan PR is opened on intents", () => {
  expect(plan()).toMatchObject({
    repo: "owner/intents",
    head: `plan/${ID}-${SLUG}`,
    base: "main",
    title: "docs(plan): Show a greeting",
  });
  expect(plan().body).toContain("Add a greeting file.");
  expect(plan().body).toContain("**Access asked for:** nothing beyond the defaults.");
  const md = p.show("intents", "main", `done/${ID}-${SLUG}/plan.md`);
  expect(md).toMatch(/^# Plan: Show a greeting\n\nIntent 261026-1000\. Spec IDs: WEB-1\./);
  expect(md).toContain("## Approach");
  // The plan run is read-only and resumes the design's session.
  const pl = call("plan");
  expect(pl.argv.slice(pl.argv.indexOf("--tools"), pl.argv.indexOf("--tools") + 2)).toEqual([
    "--tools",
    "Read,Glob,Grep,Bash",
  ]);
  expect(pl.session).toEqual({ mode: "resume", id: call("design").session.id });
});

test("pipeline: plan PR merged at a5", () => {
  expect(plan().state).toBe("MERGED");
  expect(p.tools.lines("gh")).toContain(`pr merge ${plan().number} -R owner/intents --squash`);
  expect(p.stages(m.id)).not.toContain("approval:plan");
});

test("pipeline: build prompt has plan, intent and checks", () => {
  const w = call("worker").prompt;
  expect(w).toContain("# Plan: Show a greeting");
  expect(w).toContain("Add a greeting file.");
  expect(w).toContain("# Intent: Show a greeting");
  expect(w).toContain("- The page says hello");
  expect(w).toContain("Spec requirements to build: WEB-1");
  expect(w).toContain("sh -c 'for t in tests/*.sh; do sh \"$t\" || exit 1; done'");
  expect(w).toContain("Access you have: any network domain");
  // The repo's setup ran in the checkout before the worker.
  const kinds = p.sandboxRuns.map((r) => r.kind);
  expect(kinds.indexOf("setup")).toBeLessThan(kinds.indexOf("checks"));
  expect(p.tools.spawned.findIndex((s) => s.kind === "setup")).toBeLessThan(
    p.tools.spawned.findIndex((s) => s.kind === "worker"),
  );
});

test("pipeline: build commits as the bot", () => {
  const branch = `towercab/${ID}-${SLUG}`;
  const author = git(p.bares.web!, "log", "-1", "--format=%an <%ae>|%s", branch).trim();
  expect(author).toBe("towercab[bot] <9+towercab[bot]@users.noreply.github.com>|feat: show a greeting");
  const files = git(p.bares.web!, "diff", "--name-only", `${branch}~1`, branch).trim().split("\n");
  expect(files.sort()).toEqual(["greeting.txt", "tests/greeting.sh"]);
});

test("pipeline: first publish opens the code PR", () => {
  expect(code()).toMatchObject({
    repo: "owner/web",
    head: `towercab/${ID}-${SLUG}`,
    base: "main",
    title: "feat: show a greeting",
  });
  const create = p.tools
    .lines("gh")
    .filter((l) => l.startsWith("pr create") && l.includes(`--head towercab/${ID}-${SLUG} `));
  expect(create).toHaveLength(1);
  expect(create[0]).not.toContain("--draft");
  expect(m.pr).toBe(code().number);
  expect(m.pushed_at).not.toBeNull();
  expect(m.head).toBe(git(p.bares.web!, "rev-parse", `towercab/${ID}-${SLUG}`).trim());
});

test("pipeline: PR text comes from the worker", () => {
  // PIP-108: the worker's plain brief and the risk lead; the worker's technical text follows.
  const body = code().body;
  expect(body.startsWith(`## In plain words\n\n${BUILD_BRIEF}\n\n## Risk: low`)).toBe(true);
  const at = body.indexOf(WORKER_PR);
  expect(at).toBeGreaterThan(0);
  // Code adds only its own facts after it: checks, links, IDs, the review, the footer.
  const rest = body.slice(at + WORKER_PR.length);
  expect(rest).toContain("## Checks");
  expect(rest).toContain("**Spec IDs:** WEB-1");
  expect(rest).toContain("Part of this change:");
  expect(rest).toMatch(/<sub>Built by Towercab · .* · \$1\.80 · 0h01m<\/sub>$/);
  expect(spec().body.startsWith(`## In plain words\n\n${DESIGN.brief}`)).toBe(true);
  expect(spec().body).toContain(DESIGN.pr);
});

test("pipeline: review on every PR", () => {
  const r = call("review");
  // A fresh, read-only session one step above the worker's model (sonnet → opus).
  expect(r.model).toBe("opus");
  expect(call("worker").model).toBe("sonnet");
  expect(r.session.mode).toBe("new");
  expect(r.session.id).not.toBe(call("design").session.id);
  expect(r.prompt).toContain("CI: no CI on this repo");
  expect(r.prompt).toContain("git diff refs/remotes/origin/main...HEAD");
  expect(r.prompt).toContain("# Plan: Show a greeting");
  // It ran after CI, before the gate.
  const st = p.stages(m.id);
  expect(st.indexOf("review")).toBe(st.indexOf("ci") + 1);
  expect(st.indexOf("gate")).toBe(st.indexOf("review") + 1);
});

test("pipeline: review prompt has the do-not-report defaults", () => {
  // The target repo has no REVIEW.md: the default passes and what not to report reach the review.
  const r = call("review").prompt;
  expect(r).toContain("Bugs, Security, Compliance");
  expect(r).toContain("Do not report (Towercab's defaults):");
  expect(r).toContain("linguist-generated");
});

test("pipeline: review comment is posted", () => {
  const c = code().comments.filter((x) => x.body.startsWith("<!-- towercab:review:1 -->"));
  expect(c).toHaveLength(1);
  expect(c[0]!.author).toBe("towercab[bot]");
  expect(c[0]!.body).toContain("**Review** · round 1");
  expect(c[0]!.body).toContain("Approve: small and tested.");
  expect(c[0]!.body).toContain("Met: The page says hello (greeting.txt)");
});

test("pipeline: verify runs setup then checks", () => {
  const verify = p.sandboxRuns.filter((r) => r.cwd.endsWith(`${ID}-1`)).map((r) => r.kind);
  // build's setup, then verify's setup and checks, then the screenshots.
  expect(verify).toEqual(["setup", "setup", "checks", "shots"]);
  const [, setup, checks] = p.sandboxRuns.filter((r) => r.cwd.endsWith(`${ID}-1`));
  expect(setup!.argv).not.toContain("--unshare-net");
  expect(checks!.argv).toContain("--unshare-net");
  const log = readFileSync(join(p.home.runs(ID, "verify"), "verify-1.log"), "utf8");
  expect(log).toBe("$ sh -c 'for t in tests/*.sh; do sh \"$t\" || exit 1; done'\n");
  expect(readFileSync(join(p.home.runs(ID, "verify"), "verify-1-setup.log"), "utf8")).toMatch(
    /^\$ sh -c 'echo set up/,
  );
});

test("pipeline: proof red on base proves", () => {
  // The PR's changed test, laid over base, failed there.
  const proof = p.sandboxRuns.filter((r) => r.kind === "proof");
  expect(proof).toHaveLength(1);
  expect(proof[0]!.cwd).toMatch(/-proof$/);
  expect(existsSync(proof[0]!.cwd)).toBe(false);
  expect(readFileSync(join(p.home.runs(ID, "proof"), "proof.log"), "utf8")).toContain("$ ");
  expect(code().body).toContain("- Test proof: the new tests fail without the change");
  expect(p.stages(m.id)).toContain("publish");
});

test("pipeline: screenshots reach the review", () => {
  const shot = join(p.home.runs(ID, "verify"), "shots-1", "home.png");
  expect(readFileSync(shot, "utf8")).toBe("png");
  expect(call("review").prompt).toContain(`- ${shot}`);
  expect(p.sandboxRuns.find((r) => r.kind === "shots")!.argv).toContain("--unshare-net");
});

test("runs: review reads logs and shots from stage folders", () => {
  const runs = join(p.home.root, "runs", ID);
  const shot = join(runs, "verify", "shots-1", "home.png");
  // The review is told the screenshot's place in the verify folder, and the check log is there too.
  expect(call("review").prompt).toContain(`- ${shot}`);
  expect(existsSync(join(runs, "verify", "verify-1.log"))).toBe(true);
  expect(existsSync(join(runs, "verify-1.log"))).toBe(false);
  expect(existsSync(join(runs, "shots-1"))).toBe(false);
  // Each Claude run's files sit in its own stage's folder.
  expect(existsSync(join(runs, "review", "settings-review.json"))).toBe(true);
  expect(existsSync(join(runs, "build", "guard.json"))).toBe(true);
});

test("pipeline: merge on the gated head", () => {
  const merge = p.tools.lines("gh").filter((l) => l.startsWith(`pr merge ${code().number} `));
  expect(merge).toEqual([`pr merge ${code().number} -R owner/web --squash --match-head-commit ${m.head}`]);
  expect(code().state).toBe("MERGED");
  expect(m.merge_sha).toBe(code().mergeCommit);
  expect(m.merged_by).toBe("towercab");
});

test("metrics: run cost is added once", () => {
  // Worker session totals 0.4 → 0.9 → 1.5 add 1.5 once; the review's own session adds 0.3.
  expect(m.cost_usd).toBeCloseTo(1.8, 6);
  expect(m.agent_secs).toBe(100);
  // Reading the same result again (a re-entered step) adds nothing.
  const sc = JSON.parse(m.data) as { sessionCost: Record<string, number> };
  expect(sc.sessionCost[m.session]).toBe(1.5);
});
