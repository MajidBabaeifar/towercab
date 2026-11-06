// Setting up checks for a repo that has none (REPO-5, REPO-34..37): draft, prove on the base branch, open a
// one-file PR, drive it by the repo's autonomy, and let every waiting intent carry on when it merges.

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import type { Ctx } from "../src/handlers.ts";
import type { IntentStore } from "../src/intents/types.ts";
import { insertMission, type Mission, unfinished } from "../src/mission.ts";
import { pickHandler } from "../src/pipeline/start.ts";
import {
  dropMerged,
  getSetup,
  resumable,
  reviewSetupPr,
  type SetupDeps,
  setupChecksPass,
  setupWork,
} from "../src/setup-checks.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { serve } from "./helpers/ready.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, TestClock, testConfig, testDb, testHome } from "./helpers/world.ts";

const STATIC = {
  "index.html": "<html><body><p>hi</p></body></html>",
  "feed.ics": "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
};
const NPM = {
  "package.json": JSON.stringify({ name: "web", scripts: { lint: "biome check" } }),
  Makefile: "check:\n\t./run\n",
};
const FEED = "https://example.test/hook";

/** The forge, reading the PR's files and text from the bare repo the way GitHub would. */
class RepoForge extends FakeForge {
  bare = "";
  headText: string | null = null;
  private show(spec: string): string | null {
    try {
      return execFileSync("git", ["--git-dir", this.bare, "show", spec], { encoding: "utf8", stdio: "pipe" });
    } catch {
      return null;
    }
  }
  override async prFiles(repo = "owner/web", n = 1) {
    const pr = this.prs.find((p) => p.repo === repo && p.number === n)!;
    const out = execFileSync("git", ["--git-dir", this.bare, "diff", "--name-only", `main...${pr.branch}`], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((filename) => ({ filename, status: "modified" }));
  }
  override async readFile(repo: string, path: string, ref = "main") {
    if (this.headText !== null && path === "CLAUDE.md" && ref !== "main") return this.headText;
    const branch = this.prs.find((p) => p.repo === repo && p.head === ref)?.branch ?? ref;
    return this.show(`${branch}:${path}`);
  }
}

function world(files: Record<string, string>, a = 5) {
  const bare = bareRepo(files);
  serve({ web: bare });
  const forge = new RepoForge();
  forge.bare = bare;
  const tools = new FakeTools();
  tools.present.add("python3");
  tools.present.add("node");
  const runs: { line: string; net: boolean }[] = [];
  const failOn: string[] = [];
  tools.on("bwrap", (args) => {
    const line = args.at(-1)!;
    runs.push({ line, net: !args.includes("--unshare-net") });
    return failOn.some((f) => line.includes(f)) ? failResult("boom: it failed") : okResult("ok");
  });
  const clock = new TestClock();
  const db = testDb();
  const config = testConfig({ repos: { web: { github: "owner/web" } } });
  const store = { get: async () => ({ a, source: "me" }) } as unknown as IntentStore;
  const log: string[] = [];
  const deps: SetupDeps = {
    config,
    home: testHome(),
    db,
    tools,
    clock,
    store,
    github: forge as unknown as SetupDeps["github"],
    log: (l) => log.push(l),
  };
  const repo = config.repos.get("web")!;
  const mission = (intent: string): Mission =>
    insertMission(db, { intent, slug: "x", repo: "web", model: "opus", a }, clock.now());
  const cx = {
    config,
    home: deps.home,
    db,
    tools,
    clock,
    store,
    github: forge,
    timeouts: true,
    log: () => {},
    repo: () => repo,
    checkout: () => "/nonexistent",
    runs: () => deps.home.root,
    record: (m: Mission) => m,
  } as unknown as Ctx;
  /** Pick the mission; run the job until the pick answers with more than a poll (at most 4 passes). */
  const pick = async (m: Mission) => {
    for (let i = 0; i < 4; i++) {
      const p = await pickHandler.step(cx, m);
      if (!("poll" in p)) return p;
      await setupChecksPass(deps);
    }
    throw new Error("the pick kept polling");
  };
  /** Park the mission as the pick leaves it: blocked on the setup. */
  const park = (m: Mission, waiting: string) =>
    db.run("UPDATE missions SET stage='blocked', from_stage='pick', waiting=? WHERE id=?", waiting, m.id);
  return { bare, forge, tools, runs, failOn, clock, db, deps, log, mission, pick, park, repo, cx };
}

const branchFiles = (bare: string, branch: string): string[] =>
  execFileSync("git", ["--git-dir", bare, "diff", "--name-only", `main...${branch}`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

test("repo: a draft runs on the base branch before it is proposed", async () => {
  const w = world(STATIC);
  const p = await w.pick(w.mission("261105-0001"));
  expect(p).toMatchObject({ done: { event: "wait", waiting: "setting up checks: #1" } });
  // Checks ran once, without network, on a copy of the base; the PR opened only after they passed.
  const checks = w.runs.filter((r) => !r.net);
  expect(checks).toHaveLength(1);
  expect(checks[0]!.line).toContain("unbalanced");
  expect(w.forge.calls[0]).toBe("open owner/web#1 towercab/setup-web");
  expect(w.forge.prs[0]!.body).toContain("passed once on `main`");
  expect(getSetup(w.db, "web")).toMatchObject({ state: "open", pr: 1, tried: ["the repo's plain files"] });
});

test("repo: a failing draft falls back to the next source", async () => {
  const w = world(NPM);
  w.failOn.push("npm run lint");
  await w.pick(w.mission("261105-0002"));
  const rec = getSetup(w.db, "web")!;
  expect(rec.tried).toEqual(["package.json scripts", "Makefile"]);
  expect(rec.state).toBe("open");
  expect(rec.draft!.checks[0]).toBe("make check");
  expect(w.log.some((l) => l.includes("package.json scripts failed on main"))).toBe(true);
});

test("repo: a draft that checks nothing is not used", async () => {
  // Nothing to read: the guarded test-folder line alone would pass, and is not a check.
  const w = world({ "README.md": "hello\n" });
  const p = await w.pick(w.mission("261105-0003"));
  expect(w.runs).toHaveLength(0);
  expect(w.forge.prs).toHaveLength(0);
  expect(getSetup(w.db, "web")).toMatchObject({ state: "failed", tried: [] });
  expect(p).toMatchObject({ done: { waiting: "add CLAUDE.md verifying block" } });
});

test("repo: the setup PR changes only CLAUDE.md", async () => {
  const w = world({ ...STATIC, "CLAUDE.md": "# Web\n\nNotes for the agent.\n" });
  // A CLAUDE.md without the section: the section is added and the old text stays byte-identical.
  await w.pick(w.mission("261105-0004"));
  expect(branchFiles(w.bare, "towercab/setup-web")).toEqual(["CLAUDE.md"]);
  const text = execFileSync("git", ["--git-dir", w.bare, "show", "towercab/setup-web:CLAUDE.md"], {
    encoding: "utf8",
  });
  expect(text.startsWith("# Web\n\nNotes for the agent.\n")).toBe(true);
  expect(text).toContain("## Verifying your work");
  expect(w.forge.prs[0]!.title).toBe("chore(towercab): add verifying checks");
  // The review refuses a PR that touches anything else.
  w.forge.prFiles = async () => [
    { filename: "CLAUDE.md", status: "modified" },
    { filename: "scripts/check.sh", status: "added" },
  ];
  const finds = await reviewSetupPr(w.deps, w.repo, 1, w.forge.prs[0]!.head);
  expect(finds.join(" ")).toMatch(/only `CLAUDE.md`.*scripts\/check.sh/);
});

/** Run the job until the PR is merged, held, or `n` passes are done; the clock moves past CI's grace. */
async function drive(w: ReturnType<typeof world>, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.clock.advance(200);
    await setupChecksPass(w.deps);
  }
}

test("repo: the setup PR follows the repo's autonomy", async () => {
  // a5, low risk, no CI: Towercab merges it itself.
  const w = world(STATIC, 5);
  const m = w.mission("261105-0005");
  w.park(m, (await w.pick(m)) && "setting up checks: #1");
  await drive(w);
  expect(w.forge.prs[0]!.state).toBe("MERGED");
  expect(w.forge.prs[0]!.comments[0]).toContain("Setup review: approved");
  // a3: the owner merges; Towercab says so once.
  const o = world(STATIC, 3);
  const m3 = o.mission("261105-0006");
  o.park(m3, (await o.pick(m3)) && "setting up checks: #1");
  await drive(o, 4);
  expect(o.forge.prs[0]!.state).toBe("OPEN");
  expect(o.forge.prs[0]!.comments.filter((c) => c.startsWith("Waiting for you to merge"))).toHaveLength(1);
  // A red check holds it at any autonomy.
  const r = world(STATIC, 5);
  const mr = r.mission("261105-0007");
  r.park(mr, (await r.pick(mr)) && "setting up checks: #1");
  r.forge.prs[0]!.checks = [
    { name: "ci", kind: "run", status: "COMPLETED", conclusion: "FAILURE", startedAt: null, run: 1, url: "" },
  ];
  await drive(r);
  expect(r.forge.prs[0]!.state).toBe("OPEN");
});

test("repo: the setup PR review re-runs the drafted checks", async () => {
  const w = world(STATIC, 5);
  const m = w.mission("261105-0008");
  w.park(m, (await w.pick(m)) && "setting up checks: #1");
  // The base no longer passes them when the review looks again.
  w.failOn.push("unbalanced");
  await drive(w);
  const pr = w.forge.prs[0]!;
  expect(pr.state).toBe("OPEN");
  expect(pr.comments[0]).toContain("Setup review: blocking");
  expect(pr.comments[0]).toContain("don't pass on `main`");
  expect(w.runs.filter((r) => !r.net).length).toBeGreaterThanOrEqual(2);
});

test("repo: the setup PR review blocks a command that is not a check", async () => {
  const w = world(STATIC, 5);
  const m = w.mission("261105-0009");
  w.park(m, (await w.pick(m)) && "setting up checks: #1");
  const head = w.forge.prs[0]!.head;
  for (const line of [`curl -X POST ${FEED}`, "npm publish", "echo ${{ secrets.TOKEN }}", "make deploy"]) {
    w.forge.headText = `# Web\n\n## Verifying your work\n\n\`\`\`checks\nnpm test\n${line}\n\`\`\`\n`;
    const finds = await reviewSetupPr(w.deps, w.repo, 1, head);
    expect(finds.join(" "), line).toMatch(/could deploy, publish, write over the network/);
  }
  // Blocked, not merged, at any autonomy.
  w.forge.headText = "# Web\n\n## Verifying your work\n\n```checks\nnpm test\nnpm publish\n```\n";
  await drive(w);
  expect(w.forge.prs[0]!.state).toBe("OPEN");
  expect(w.forge.prs[0]!.comments[0]).toContain("blocking");
});

test("repo: one setup PR per repo", async () => {
  const w = world(STATIC);
  const a = w.mission("261105-0010");
  const b = w.mission("261105-0011");
  await w.pick(a);
  await w.pick(b);
  expect(w.forge.prs).toHaveLength(1);
  // A restart in the middle of the push adopts the PR on the branch instead of opening another.
  const rec = getSetup(w.db, "web")!;
  w.db.setMeta("setup-checks:web", JSON.stringify({ ...rec, state: "pushing", pr: undefined }));
  await setupChecksPass(w.deps);
  expect(w.forge.prs).toHaveLength(1);
  expect(getSetup(w.db, "web")).toMatchObject({ state: "open", pr: 1 });
  expect(setupWork(w.db, w.deps.config, w.clock.now())).toBe(true);
});

test("repo: every intent of the repo waits on the setup PR", async () => {
  const w = world(STATIC);
  const ps = [];
  for (const id of ["261105-0012", "261105-0013", "261105-0014"]) ps.push(await w.pick(w.mission(id)));
  for (const p of ps) {
    expect(p).toMatchObject({ done: { event: "wait", waiting: "setting up checks: #1" } });
  }
  expect(w.forge.prs).toHaveLength(1);
});

test("repo: a merged setup PR resumes the waiting intents", async () => {
  const w = world(STATIC, 3);
  const ms = [w.mission("261105-0015"), w.mission("261105-0016")];
  for (const m of ms) w.park(m, (await w.pick(m)) && "setting up checks: #1");
  expect(resumable(w.db)).toHaveLength(0);
  // The owner merges it.
  w.forge.prs[0]!.state = "MERGED";
  await drive(w, 1);
  expect(getSetup(w.db, "web")!.state).toBe("merged");
  // Both carry on, with no reply, and the finished record goes.
  expect(
    resumable(w.db)
      .map((m) => m.intent)
      .sort(),
  ).toEqual(["261105-0015", "261105-0016"]);
  dropMerged(w.db, w.deps.config);
  expect(getSetup(w.db, "web")).toBeNull();
  expect(unfinished(w.db)).toHaveLength(2);
  // Without a record they still resume (nothing keeps them waiting).
  expect(resumable(w.db)).toHaveLength(2);
});

test("repo: a closed setup PR asks the owner", async () => {
  const w = world(STATIC, 3);
  const m = w.mission("261105-0017");
  w.park(m, (await w.pick(m)) && "setting up checks: #1");
  w.forge.prs[0]!.state = "CLOSED";
  await drive(w, 1);
  expect(resumable(w.db)).toHaveLength(1);
  const p = await pickHandler.step(w.cx, m);
  expect(p).toMatchObject({ done: { event: "wait", waiting: "add CLAUDE.md verifying block" } });
  expect((p as { done: { why: string } }).done.why).toContain("#1");
  // The owner's reply starts a new try instead of asking again.
  const again = await pickHandler.step(w.cx, m);
  expect(again).toEqual({ poll: 5 });
  expect(getSetup(w.db, "web")!.state).toBe("drafting");
});

test("repo: no passing draft asks the owner", async () => {
  const w = world(STATIC);
  w.failOn.push("unbalanced", "VCALENDAR");
  const m = w.mission("261105-0018");
  const p = await w.pick(m);
  expect(w.forge.prs).toHaveLength(0);
  expect(p).toMatchObject({ done: { event: "wait", waiting: "add CLAUDE.md verifying block" } });
  expect(getSetup(w.db, "web")!.state).toBe("failed");
  // Nothing is drafted again until the owner replies.
  expect(await pickHandler.step(w.cx, w.mission("261105-0019"))).toMatchObject({
    done: { waiting: "add CLAUDE.md verifying block" },
  });
  expect(setupWork(w.db, w.deps.config, w.clock.now())).toBe(false);
});

test("repo: the ask names what was tried", async () => {
  const w = world(NPM);
  w.failOn.push("npm run lint", "make check");
  const p = await w.pick(w.mission("261105-0020"));
  const why = (p as { done: { why: string } }).done.why;
  expect(why).toContain("Towercab tried package.json scripts, Makefile and none passed on main");
  expect(why).toContain("boom: it failed");
});
