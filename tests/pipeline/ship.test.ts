// The ship stage (SHIP-1..15): after the merge, wait for the platform's deploy, run the e2e suites
// against the live URL, and when they fail, ask for the last good version, fix forward, and after
// two fixes revert. The fake `gh` serves GitHub Deployments; `platform` plays the deploy side.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dataOf, type Mission } from "../../src/mission.ts";
import { build, checkRun, happy, ID, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { type ClaudeReply, Pipe } from "../helpers/pipe.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { git } from "../helpers/world.ts";

const URL = "https://web.example.dev";
const TOKEN = "s3cret-token-42";

const LIVE = `---
live:
  url: ${URL}
  timeout: 5
  suites:
    - name: smoke
      command: sh e2e/smoke.sh
      tests: [e2e/smoke.sh]
      smoke: true
    - name: greet
      command: sh e2e/greet.sh
      tests: [e2e/greet.sh]
      paths: [greeting.txt]
---
`;

/** A live repo: the smoke suite checks BASE_URL and prints the secret; greet starts empty. */
const SHIP_TARGET: Record<string, string> = {
  ...TARGET,
  "TOWERCAB.md": LIVE,
  "e2e/smoke.sh": `test "$BASE_URL" = ${URL} || { echo "BASE_URL is $BASE_URL"; exit 1; }\necho "token $E2E_TOKEN"\n`,
  "e2e/greet.sh": "true\n",
};

const GREET_E2E = 'grep -q hello greeting.txt || { echo "no hello on the page"; exit 1; }\n';

function world(target: Record<string, string> = SHIP_TARGET): Pipe {
  const p = new Pipe(target, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  const dir = join(p.home.root, "secrets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "web.env"), `# e2e login\nE2E_TOKEN=${TOKEN}\n`);
  chmodSync(join(dir, "web.env"), 0o600);
  return p;
}

const moves = (p: Pipe) =>
  p.db.all<{ from_stage: string; event: string; to_stage: string; why: string | null }>(
    "SELECT from_stage, event, to_stage, why FROM transitions ORDER BY id",
  );
const e2eRuns = (p: Pipe) =>
  p.sandboxRuns.filter((r) => r.kind === "e2e").map((r) => /sh e2e\/(\w+)\.sh/.exec(r.argv.at(-1)!)?.[1]);
const e2eLogs = (p: Pipe) => {
  const d = join(p.home.root, "runs", ID, "e2e");
  return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")) : [];
};
const rollbacks = (p: Pipe) => p.deployments.filter((d) => d.task === "deploy:rollback");

describe("ship: the happy path", () => {
  let p: Pipe;
  let m: Mission;
  let waited: string;

  beforeAll(async () => {
    p = world();
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
      "e2e/greet.sh": GREET_E2E,
    });
    await p.start();
    // No Deployment yet: the stage waits.
    await p.untilStage("deploy");
    await p.until(() => false, 3);
    waited = `${p.mission()!.stage}/${p.mission()!.step}`;
    p.platform = () => ({ state: "success" });
    p.deploy("owner/web", p.mission()!.merge_sha!, "deploy", null);
    m = await p.untilStage("done");
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: deploy waits for the merge commit", () => {
    expect(waited).toBe("deploy/wait");
    expect(moves(p)).toContainEqual(
      expect.objectContaining({ from_stage: "merge", event: "code_merged", to_stage: "deploy" }),
    );
    expect(moves(p)).toContainEqual(
      expect.objectContaining({
        from_stage: "deploy",
        event: "ok",
        to_stage: "e2e",
        why: `${m.merge_sha!.slice(0, 7)} is live`,
      }),
    );
  });

  test("ship: github adapter reads deployments", () => {
    const reads = p.forge.calls.filter((l) => l.startsWith("deployment"));
    expect(reads).toContain(`deployments owner/web ${m.merge_sha}`);
    expect(reads.some((l) => /^deployment-status owner\/web \d+$/.test(l))).toBe(true);
    expect(p.forge.calls.some((l) => l.startsWith("deploy "))).toBe(false);
  });

  test("ship: suites run in order against the URL", () => {
    // greet's test changed, so it runs first; smoke (which checks BASE_URL) after.
    expect(e2eRuns(p)).toEqual(["greet", "smoke"]);
    expect(moves(p).at(-1)).toMatchObject({ from_stage: "e2e", event: "ok", to_stage: "done" });
  });

  test("ship: green records the last good version", () => {
    expect(p.db.meta("lastgood:web")).toBe(m.merge_sha);
  });

  test("ship: secrets are redacted from logs", () => {
    const logs = e2eLogs(p).join("\n");
    expect(logs).toContain("token [redacted]");
    expect(logs).not.toContain(TOKEN);
  });
});

describe("ship: red, rollback, fix forward", () => {
  let p: Pipe;
  let m: Mission;
  const firstParent = () => {
    const merges = (dataOf(m) as { ship?: { merges: string[] } }).ship!.merges;
    return git(p.bares.web!, "rev-parse", `${merges[0]}^`).trim();
  };

  beforeAll(async () => {
    p = world();
    p.platform = () => ({ state: "success" });
    let round = 0;
    p.respond.worker = (): ClaudeReply => {
      round++;
      return round === 1
        ? {
            structured: build(),
            edits: {
              "greeting.txt": "hullo\n",
              "tests/greeting.sh": "test -f greeting.txt\n",
              "e2e/greet.sh": GREET_E2E,
            },
          }
        : {
            structured: build(),
            edits: { "greeting.txt": "hello\n", "tests/greeting-text.sh": "grep -q hello greeting.txt\n" },
          };
    };
    await p.start();
    m = await p.untilStage("done", 120);
  }, 120_000);

  afterAll(() => p.cleanup());

  test("ship: a red suite runs once more", () => {
    const first = e2eRuns(p).slice(0, 2);
    expect(first).toEqual(["greet", "greet"]);
    expect(moves(p)).toContainEqual(
      expect.objectContaining({
        from_stage: "e2e",
        event: "red",
        to_stage: "rollback",
        why: `e2e suite greet failed twice against ${URL}`,
      }),
    );
  });

  test("ship: rollback asks for the last good version", () => {
    // Nothing was green yet: the last good version is the commit before the intent's first merge.
    expect(rollbacks(p).map((d) => d.sha)).toEqual([firstParent()]);
    expect(rollbacks(p)[0]!.payload).toMatchObject({ intent: ID });
  });

  test("ship: github adapter asks for a rollback once", () => {
    expect(p.forge.calls.filter((l) => l.startsWith("deploy "))).toHaveLength(1);
  });

  test("ship: rollback starts a fix round", () => {
    expect(moves(p)).toContainEqual(
      expect.objectContaining({ from_stage: "rollback", event: "ok", to_stage: "build" }),
    );
    expect(m.branch).toMatch(/-fix1$/);
    const code = p.prs.filter(
      (x) => x.repo === "owner/web" && x.head.startsWith(`towercab/${ID}`) && !x.head.endsWith("-spec"),
    );
    expect(code.map((x) => x.state)).toEqual(expect.arrayContaining(["MERGED", "MERGED"]));
    // The replaced PR stays on record, so the intent page still lists it (UI-124).
    const first = code.find((x) => !x.head.endsWith("-fix1"))!;
    expect((dataOf(m) as { ship?: { prs?: number[] } }).ship!.prs).toEqual([first.number]);
    expect(m.pr).not.toBe(first.number);
    const fix = p.claudeCalls.filter((c) => c.kind === "worker").at(-1)!;
    expect(fix.prompt).toContain("the e2e suite `greet` failed twice");
    expect(fix.prompt).toContain("no hello on the page");
    // The fix shipped and passed: done, and the fix is the last good version.
    expect(m.stage).toBe("done");
    expect(p.db.meta("lastgood:web")).toBe(m.merge_sha);
    // A fix round needs no new e2e test of its own (SHIP-8).
    expect(
      moves(p).filter((x) => x.why === "The change has no test that runs against the live app."),
    ).toEqual([]);
  });
});

/** A worker whose every round changes the greeting (with a test that proves it) but never says hello. */
function neverHello(p: Pipe): void {
  let round = 0;
  p.respond.worker = () => {
    round++;
    const edits: Record<string, string> = {
      "greeting.txt": `${Array.from({ length: round }, (_, i) => `hullo ${i + 1}`).join("\n")}\n`,
      [`tests/greeting-${round}.sh`]: `grep -q "hullo ${round}" greeting.txt\n`,
    };
    if (round === 1) edits["e2e/greet.sh"] = GREET_E2E;
    return { structured: build(), edits };
  };
}

describe("ship: two fixes then revert", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = world();
    p.platform = () => ({ state: "success" });
    neverHello(p);
    await p.start();
    m = await p.untilStage("blocked", 200);
  }, 180_000);

  afterAll(() => p.cleanup());

  test("ship: two fixes then revert", () => {
    expect([m.stage, m.waiting], JSON.stringify(moves(p))).toEqual(["blocked", "rolled back, revise"]);
    expect(
      moves(p)
        .filter((x) => x.from_stage === "rollback")
        .map((x) => x.to_stage),
    ).toEqual(["build", "build", "revert"]);
  });

  test("ship: revert undoes every merge and hands back", () => {
    const revert = p.prs.find((x) => x.title === "Revert: Show a greeting")!;
    expect(revert.state).toBe("MERGED");
    expect(revert.body).toContain("e2e suite `greet` failed");
    expect(() => p.show("web", "main", "greeting.txt")).toThrow();
    expect(p.show("web", "main", "e2e/greet.sh")).toBe("true\n");
    expect(m.why).toContain(`greet failed against ${URL}`);
  });
});

describe("ship: a revert whose CI is red", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = world();
    p.platform = () => ({ state: "success" });
    neverHello(p);
    p.newPrChecks = (pr) => (pr.title.startsWith("Revert:") ? [checkRun("test", "FAILURE")] : []);
    await p.start();
    m = await p.untilStage("blocked", 200);
  }, 180_000);

  afterAll(() => p.cleanup());

  test("ship: a red revert freezes the repo", () => {
    expect([m.waiting, m.why], JSON.stringify(moves(p))).toEqual([
      "rollback failed",
      "the revert PR's CI is red",
    ]);
    expect(p.prs.find((x) => x.title === "Revert: Show a greeting")?.state).toBe("OPEN");
    // main still has the change: nothing merged without green CI.
    expect(p.show("web", "main", "greeting.txt")).toContain("hullo 3");
  });
});

describe("ship: a failed deploy", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = world();
    // The spec's merge deploys fine; the code's fails the platform's health check, which puts the
    // spec's merge back by itself.
    let web = 0;
    p.platform = (_sha, task, repo) => {
      if (repo !== "owner/web" || task !== "deploy") return { state: "success" };
      web++;
      return web === 2 ? { state: "failure", description: "health check red" } : { state: "success" };
    };
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
      "e2e/greet.sh": GREET_E2E,
    });
    await p.start();
    await p.until(() => (p.mission()?.branch ?? "").endsWith("-fix1"), 120);
    m = p.mission()!;
  }, 120_000);

  afterAll(() => p.cleanup());

  test("ship: a failed deploy is red", () => {
    expect(moves(p)).toContainEqual(
      expect.objectContaining({
        from_stage: "deploy",
        event: "red",
        to_stage: "rollback",
        why: "the deploy failed: health check red",
      }),
    );
  });

  test("ship: no request when it is already back", () => {
    expect(rollbacks(p)).toEqual([]);
    expect(m.branch).toMatch(/-fix1$/);
    expect(e2eRuns(p)).toEqual(["smoke"]);
  });
});

describe("ship: a rollback that fails", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = world();
    // Nothing ever goes live: the deploy times out, and so does the rollback.
    p.platform = null;
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
      "e2e/greet.sh": GREET_E2E,
    });
    await p.start();
    m = await p.untilStage("blocked", 120);
  }, 120_000);

  afterAll(() => p.cleanup());

  test("ship: no deploy in time is red", () => {
    expect(moves(p)).toContainEqual(
      expect.objectContaining({
        from_stage: "deploy",
        event: "red",
        to_stage: "rollback",
        why: "not live after 5 minutes",
      }),
    );
  });

  test("ship: a failed rollback freezes the repo", () => {
    expect([m.waiting, m.why]).toEqual([
      "rollback failed",
      `${rollbacks(p)[0]!.sha.slice(0, 7)} was not live after 5 minutes`,
    ]);
    expect(rollbacks(p)).toHaveLength(1);
  });
});

describe("ship: the command adapter", () => {
  let p: Pipe;
  let m: Mission;
  let liveFile: string;

  beforeAll(async () => {
    const target = {
      ...SHIP_TARGET,
      "TOWERCAB.md": LIVE.replace(
        `  timeout: 5\n`,
        `  timeout: 5\n  adapter: command\n  live_command: cat "$LIVE_FILE"\n  rollback_command: echo "$TOWERCAB_ROLLBACK_SHA" > "$LIVE_FILE"\n`,
      ),
    };
    p = world(target);
    liveFile = join(p.dir("tc-live-"), "live");
    writeFileSync(liveFile, "none\n");
    writeFileSync(join(p.home.root, "secrets", "web.env"), `E2E_TOKEN=${TOKEN}\nLIVE_FILE=${liveFile}\n`);
    // `tools.run` of the sandbox: the command with `sh`, in its env.
    p.tools.on("bwrap", (args, opts) => {
      const at = args.indexOf("--");
      const [, , line] = args.slice(at + 1);
      try {
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        return okResult(
          execFileSync("sh", ["-c", line!], { cwd: opts.cwd, env: opts.env, encoding: "utf8" }),
        );
      } catch (e) {
        return failResult(String((e as Error).message));
      }
    });
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
      "e2e/greet.sh": GREET_E2E,
    });
    await p.start();
    await p.untilStage("deploy");
    writeFileSync(liveFile, `${p.mission()!.merge_sha}\n`);
    m = await p.untilStage("done");
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: command adapter", () => {
    expect(m.stage).toBe("done");
    expect(p.forge.calls.filter((l) => l.startsWith("deployment") || l.startsWith("deploy "))).toEqual([]);
    expect(e2eRuns(p)).toEqual(["greet", "smoke"]);
  });
});

describe("ship: e2e tests in the change", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    p = world();
    // The worker adds no e2e test, and the plan says nothing about one.
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
    });
    await p.start();
    m = await p.untilStage("approval:merge");
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: the gate wants an e2e test", () => {
    expect([m.waiting, m.why]).toEqual([
      "review and merge PR",
      "The change has no test that runs against the live app.",
    ]);
  });

  test("ship: the plan names its e2e tests", () => {
    const plan = p.claudeCalls.find((c) => c.kind === "plan")!.prompt;
    expect(plan).toContain(`against the live app at ${URL}`);
    expect(plan).toContain("- `greet`: tests in `e2e/greet.sh`");
    expect(plan).toContain("`e2e.none_why`");
    const review = p.claudeCalls.find((c) => c.kind === "review")!.prompt;
    expect(review).toContain("Check that the change adds e2e tests under those globs");
  });
});

describe("ship: without a live block", () => {
  let p: Pipe;

  beforeAll(async () => {
    p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
    happy(p);
    await p.start();
    await p.untilStage("done");
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: no live block means done at merge", () => {
    expect(moves(p).slice(-2)).toEqual([
      { from_stage: "merge", event: "code_merged", to_stage: "deploy", why: null },
      { from_stage: "deploy", event: "skip", to_stage: "done", why: null },
    ]);
    expect(p.forge.calls.filter((l) => l.startsWith("deployment") || l.startsWith("deploy "))).toEqual([]);
    expect(p.sandboxRuns.filter((r) => r.kind.startsWith("e2e"))).toEqual([]);
  });
});

describe("ship: a live block merged while the change was built", () => {
  let p: Pipe;
  let m: Mission;

  beforeAll(async () => {
    // The repo opts in only after the change passed review, the way tracker did.
    p = world(TARGET);
    p.respond.review = () => {
      p.pushTo("web", "main", {
        "TOWERCAB.md": LIVE,
        "e2e/smoke.sh": SHIP_TARGET["e2e/smoke.sh"]!,
        "e2e/greet.sh": "true\n",
      });
      return { structured: REVIEW };
    };
    await p.start();
    await p.until(() => ["deploy", "done"].includes(p.mission()?.stage ?? ""));
    await p.until(() => false, 2);
    m = p.mission()!;
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: a live block merged meanwhile counts", () => {
    expect(`${m.stage}/${m.step}`, JSON.stringify(moves(p))).toBe("deploy/wait");
    expect(moves(p).some((x) => x.event === "skip")).toBe(false);
  });
});
