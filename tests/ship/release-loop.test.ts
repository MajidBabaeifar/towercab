// SHIP-30..32: a fake repo with a release PR, through the release pass the loop runs every minute.

import { expect, test } from "vitest";
import type { GitHub } from "../../src/handlers.ts";
import { insertMission } from "../../src/mission.ts";
import { heldReleases, releaseLine, releaseTitle, runReleases } from "../../src/ship/releases.ts";
import { overview } from "../../src/ui/state.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { testConfig, testDb } from "../helpers/world.ts";

const NOW = 1_793_000_000;
const DAY = 86_400;

const patch = (...lines: string[]) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;
const RELEASE_FILES = [
  { filename: "CHANGELOG.md", patch: patch("+## 1.3.0", "+* **ui:** a new thing") },
  {
    filename: ".release-please-manifest.json",
    patch: patch('-  ".": "1.2.0"', '+  ".": "1.3.0"'),
  },
  { filename: "package.json", patch: patch('-  "version": "1.2.0",', '+  "version": "1.3.0",') },
];

interface World {
  calls: string[][];
  main: string;
  prHead: string;
  mergeBase: string;
  files: { filename: string; patch?: string }[];
  body: string;
  author: string;
  open: boolean;
  runs: { name: string; status: string; conclusion: string | null }[];
  required: string[] | null;
  towercab: string | null;
  config: string | null;
  mergeFail: string | null;
  mainAfterRead: string | null;
  releases: { tag_name: string; html_url: string; created_at: string }[];
  contains: Record<string, string>;
}

function world(): World {
  return {
    calls: [],
    main: "m1",
    prHead: "p1",
    mergeBase: "m1",
    files: RELEASE_FILES,
    body: "release 1.3.0",
    author: "github-actions[bot]",
    open: true,
    runs: [{ name: "ci", status: "completed", conclusion: "success" }],
    required: null,
    towercab: null,
    config: "{}",
    mergeFail: null,
    mainAfterRead: null,
    releases: [],
    contains: {},
  };
}

function fake(w: World): GitHub {
  let mainReads = 0;
  return {
    me: "owner",
    owner: async () => failResult("no"),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "towercab[bot]", id: 9, email: "x" }),
    gh: async (_repo, args) => {
      w.calls.push(args);
      if (args[0] === "pr" && args[1] === "merge") {
        if (w.mergeFail) return failResult(w.mergeFail);
        w.open = false;
        return okResult();
      }
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (args[0] !== "api") return failResult(`unexpected ${args.join(" ")}`);
      if (path.includes("/pulls?")) {
        return okResult(
          JSON.stringify(
            w.open ? [{ number: 7, body: w.body, user: { login: w.author }, head: { sha: w.prHead } }] : [],
          ),
        );
      }
      if (/\/commits\/main$/.test(path)) {
        mainReads++;
        return okResult(JSON.stringify({ sha: mainReads > 1 && w.mainAfterRead ? w.mainAfterRead : w.main }));
      }
      if (path.includes("/compare/") && path.includes(`${w.main}...`))
        return okResult(JSON.stringify({ merge_base_commit: { sha: w.mergeBase } }));
      if (path.includes("/pulls/7/files")) return okResult(JSON.stringify(w.files));
      if (path.includes("/contents/release-please-config.json"))
        return w.config === null ? failResult("404") : okResult(w.config);
      if (path.includes("/contents/TOWERCAB.md"))
        return w.towercab === null ? failResult("404") : okResult(w.towercab);
      if (path.includes("/check-runs")) return okResult(JSON.stringify({ check_runs: w.runs }));
      if (path.endsWith("/status")) return okResult(JSON.stringify({ statuses: [] }));
      if (path.includes("/required_status_checks"))
        return w.required === null ? failResult("404") : okResult(JSON.stringify({ contexts: w.required }));
      if (path.includes("/releases?")) return okResult(JSON.stringify(w.releases));
      const cmp = /compare\/([^.]+)\.\.\.(.+)$/.exec(path);
      if (cmp) {
        const has = w.contains[decodeURIComponent(cmp[2]!)] === cmp[1];
        return okResult(JSON.stringify({ status: has ? "ahead" : "behind" }));
      }
      return failResult(`unhandled ${path}`);
    },
  };
}

function setup(w = world()) {
  const db = testDb();
  const logs: string[] = [];
  const config = testConfig();
  const github = fake(w);
  const pass = (now = NOW) => runReleases({ github, db, config, now, log: (l) => logs.push(l) });
  const merges = () => w.calls.filter((c) => c[0] === "pr" && c[1] === "merge");
  return { w, db, logs, config, pass, merges };
}

test("ship: a release PR touching only release files is merged", async () => {
  const s = setup();
  await s.pass();
  expect(s.merges()).toHaveLength(1);
  expect(s.merges()[0]).toEqual([
    "pr",
    "merge",
    "7",
    "--squash",
    "--match-head-commit",
    "p1",
    "-R",
    "owner/web",
  ]);
  expect(s.logs).toContain("merged release PR #7 of web");
  expect(heldReleases(s.db, NOW)).toEqual([]);
});

test("ship: a release PR is merged once main is green", async () => {
  const s = setup();
  s.w.runs = [{ name: "ci", status: "in_progress", conclusion: null }];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  s.w.runs = [{ name: "ci", status: "completed", conclusion: "success" }];
  await s.pass(NOW + 60);
  expect(s.merges()).toHaveLength(1);
  expect(heldReleases(s.db, NOW + 60)).toEqual([]);
});

test("ship: a release PR is merged only against the commit that is green", async () => {
  const s = setup();
  s.w.mainAfterRead = "m2";
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  s.w.mainAfterRead = null;
  await s.pass(NOW + 60);
  expect(s.merges()).toHaveLength(1);
});

test("ship: a stale release PR waits for main", async () => {
  const s = setup();
  s.w.mergeBase = "older";
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW);
  expect(h).toMatchObject({ reason: "stale", card: false });
  s.w.mergeBase = "m1";
  await s.pass(NOW + 60);
  expect(s.merges()).toHaveLength(1);
});

test("ship: the release PR is never edited", async () => {
  const s = setup();
  s.w.files = [...RELEASE_FILES, { filename: "src/a.ts", patch: patch("+x") }];
  await s.pass();
  s.w.files = RELEASE_FILES;
  await s.pass(NOW + 60);
  const writes = s.w.calls.filter(
    (c) => !(c[0] === "api" && !c.includes("-X")) && !(c[0] === "pr" && c[1] === "merge"),
  );
  expect(writes).toEqual([]);
  expect(s.w.calls.some((c) => c[0] === "pr" && (c[1] === "comment" || c[1] === "edit"))).toBe(false);
});

test("ship: a refused release merge is retried then held", async () => {
  const s = setup();
  s.w.mergeFail = "Pull request is not mergeable";
  await s.pass();
  await s.pass(NOW + 60);
  expect(heldReleases(s.db, NOW + 60)[0]).toMatchObject({ refusals: 2, card: false });
  await s.pass(NOW + 120);
  expect(s.merges()).toHaveLength(3);
  const [h] = heldReleases(s.db, NOW + 120);
  expect(h).toMatchObject({ refusals: 3, card: true });
  expect(h!.why).toContain("Pull request is not mergeable");
});

test("ship: a release PR touching other files is held", async () => {
  const s = setup();
  s.w.files = [...RELEASE_FILES, { filename: "src/a.ts", patch: patch("+x") }];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW);
  expect(h).toMatchObject({ reason: "files", card: true });
  expect(h!.why).toContain("src/a.ts");
});

test("ship: a release PR is held while main is red", async () => {
  const s = setup();
  s.w.runs = [{ name: "ci", status: "completed", conclusion: "failure" }];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  expect(heldReleases(s.db, NOW)[0]).toMatchObject({ reason: "checks", card: false });
});

test("ship: a release PR is held while main has no checks", async () => {
  const s = setup();
  s.w.runs = [];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW + DAY);
  expect(h).toMatchObject({ reason: "checks", card: true });
  expect(h!.why).toBe("This repo runs no checks on main.");
});

test("ship: a major release is held for the owner", async () => {
  const s = setup();
  s.w.files = [
    RELEASE_FILES[0]!,
    { filename: ".release-please-manifest.json", patch: patch('-  ".": "1.2.0"', '+  ".": "2.0.0"') },
  ];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW);
  expect(h).toMatchObject({ reason: "major", card: true });
  expect(h!.why).toBe("Major release 1.2.0 → 2.0.0.");
});

test("ship: a breaking 0.x release is held for the owner", async () => {
  const s = setup();
  s.w.body = "### ⚠ BREAKING CHANGES\n\n* the API changed";
  s.w.files = [
    { filename: ".release-please-manifest.json", patch: patch('-  ".": "0.4.0"', '+  ".": "0.5.0"') },
  ];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  expect(heldReleases(s.db, NOW)[0]).toMatchObject({ reason: "breaking", card: true });
});

test("ship: a breaking change in the release notes is held", async () => {
  const s = setup();
  s.w.files = [{ filename: "CHANGELOG.md", patch: patch("+* feat(api)!: drop v1") }, RELEASE_FILES[1]!];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW);
  expect(h!.why).toContain("drop v1");
});

test("ship: a manual repo's release PR is a Needs you card", async () => {
  const s = setup();
  s.w.towercab = "---\nreleases: manual\n---\n";
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  const [h] = heldReleases(s.db, NOW);
  expect(h).toMatchObject({ reason: "manual", card: true, why: "This repo merges its releases by hand." });
  expect(releaseTitle(h!)).toBe("Release PR #7 of web needs you");
});

test("ship: a minor release is merged", async () => {
  const s = setup();
  await s.pass();
  expect(s.merges()).toHaveLength(1);
});

test("ship: a release PR held for 24 hours gets a card naming the checks", async () => {
  const s = setup();
  s.w.required = ["build", "lint"];
  s.w.runs = [
    { name: "build", status: "completed", conclusion: "failure" },
    { name: "lint", status: "completed", conclusion: "success" },
  ];
  await s.pass();
  expect(heldReleases(s.db, NOW)[0]!.card).toBe(false);
  await s.pass(NOW + DAY - 60);
  expect(heldReleases(s.db, NOW + DAY - 60)[0]!.card).toBe(false);
  await s.pass(NOW + DAY);
  const [h] = heldReleases(s.db, NOW + DAY);
  expect(h).toMatchObject({ card: true, since: NOW });
  expect(h!.why).toBe("Checks on main are red: build.");
  expect(releaseTitle(h!)).toBe("Release PR #7 of web has waited a day");
});

test("ship: a held release PR is a Needs you card", async () => {
  const s = setup();
  s.w.files = [...RELEASE_FILES, { filename: "src/a.ts", patch: patch("+x") }];
  await s.pass();
  const f = overviewSources(s);
  const o = await overview(f);
  const card = o.needs.find((c) => c.intent === "release:web")!;
  expect(card).toMatchObject({
    kind: "release",
    title: "Release PR #7 of web needs you",
    pr: { number: 7, url: "https://github.com/owner/web/pull/7" },
    actions: [],
  });
});

test("ship: the card clears when the PR is merged or closed", async () => {
  const s = setup();
  s.w.files = [...RELEASE_FILES, { filename: "src/a.ts", patch: patch("+x") }];
  await s.pass();
  expect(heldReleases(s.db, NOW)).toHaveLength(1);
  s.w.open = false;
  await s.pass(NOW + 60);
  expect(heldReleases(s.db, NOW + 60)).toEqual([]);
  s.w.open = true;
  await s.pass(NOW + 120);
  expect(heldReleases(s.db, NOW + 120)).toHaveLength(1);
  s.w.files = RELEASE_FILES;
  await s.pass(NOW + 180);
  expect(heldReleases(s.db, NOW + 180)).toEqual([]);
});

test("ship: extra-files of the release config count as release files", async () => {
  const s = setup();
  s.w.config = JSON.stringify({ "extra-files": ["src/version.ts"] });
  s.w.files = [
    ...RELEASE_FILES,
    {
      filename: "src/version.ts",
      patch: patch('-export const VERSION = "1.2.0";', '+export const VERSION = "1.3.0";'),
    },
  ];
  await s.pass();
  expect(s.merges()).toHaveLength(1);
});

test("ship: go.mod is not a release file", async () => {
  const s = setup();
  s.w.files = [...RELEASE_FILES, { filename: "go.mod", patch: patch("-go 1.21", "+go 1.22") }];
  await s.pass();
  expect(s.merges()).toHaveLength(0);
  expect(heldReleases(s.db, NOW)[0]!.why).toContain("go.mod");
});

function mission(s: ReturnType<typeof setup>, stage: "done" | "unverified" = "done", sha = "abc") {
  const m = insertMission(s.db, { intent: "261104-1700", slug: "x", repo: "web", model: "m", a: 5 }, NOW);
  s.db.run("UPDATE missions SET stage = ?, merge_sha = ? WHERE id = ?", stage, sha, m.id);
  return s.db.get<import("../../src/mission.ts").Mission>("SELECT * FROM missions WHERE id = ?", m.id)!;
}

test("ship: published links the release containing the merge", async () => {
  const s = setup();
  s.w.open = false;
  s.w.releases = [
    {
      tag_name: "v1.4.0",
      html_url: "https://github.com/owner/web/releases/tag/v1.4.0",
      created_at: "2026-11-03T00:00:00Z",
    },
    {
      tag_name: "v1.3.0",
      html_url: "https://github.com/owner/web/releases/tag/v1.3.0",
      created_at: "2026-11-01T00:00:00Z",
    },
    {
      tag_name: "v1.2.0",
      html_url: "https://github.com/owner/web/releases/tag/v1.2.0",
      created_at: "2026-10-01T00:00:00Z",
    },
  ];
  s.w.contains = { "v1.3.0": "abc", "v1.4.0": "abc" };
  const m = mission(s);
  await s.pass();
  const fresh = s.db.get<import("../../src/mission.ts").Mission>(
    "SELECT * FROM missions WHERE id = ?",
    m.id,
  )!;
  expect(releaseLine(s.db, fresh)).toEqual({
    text: "Published in v1.3.0",
    url: "https://github.com/owner/web/releases/tag/v1.3.0",
  });
});

test("ship: merged shows waiting for a release", async () => {
  const s = setup();
  s.w.open = false;
  const m = mission(s, "unverified");
  await s.pass();
  expect(releaseLine(s.db, m)).toEqual({ text: "Merged, waiting for a release", url: null });
});

test("ship: repos without release-please show no release line", async () => {
  const s = setup();
  s.w.config = null;
  const m = mission(s);
  await s.pass();
  expect(releaseLine(s.db, m)).toBeNull();
  expect(s.w.calls.filter((c) => c[0] === "pr")).toEqual([]);
});

function overviewSources(s: ReturnType<typeof setup>): Parameters<typeof overview>[0] {
  return {
    db: s.db,
    config: s.config,
    clock: { now: () => NOW, mono: () => 1 },
    store: { list: async () => ({ open: [], done: [], unreadable: [], droppedIds: new Set(), head: "h" }) },
    home: { root: "/nonexistent" },
    running: true,
    paused: () => false,
    pausedAt: () => null,
    problems: () => [],
    version: () => ({ commit: "x", behind: null }),
    upNext: () => [],
    intentUrl: () => null,
  } as unknown as Parameters<typeof overview>[0];
}
