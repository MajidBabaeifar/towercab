// SHIP-30..32 hardening: what the code review found (lookup cost, failed reads, loose version rule,
// the refusal clock).

import { expect, test } from "vitest";
import type { GitHub } from "../../src/handlers.ts";
import { insertMission, type Mission } from "../../src/mission.ts";
import { decideRelease, foreignVersionFiles, type ReleaseInput } from "../../src/ship/release.ts";
import { heldReleases, runReleases } from "../../src/ship/releases.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { testConfig, testDb } from "../helpers/world.ts";

const NOW = 1_793_000_000;
const patch = (...lines: string[]) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;
const manifest = {
  name: ".release-please-manifest.json",
  patch: patch('-  ".": "1.2.0"', '+  ".": "1.3.0"'),
};

test("ship: a dependency's version line in a lock file holds the release", () => {
  const lock = {
    name: "package-lock.json",
    patch: patch('-      "version": "4.0.1",', '+      "version": "4.0.2",'),
  };
  expect(foreignVersionFiles([manifest, lock], [])).toEqual(["package-lock.json"]);
  const ok = { name: "package-lock.json", patch: patch('-  "version": "1.2.0",', '+  "version": "1.3.0",') };
  expect(foreignVersionFiles([manifest, ok], [])).toEqual([]);
  const input: ReleaseInput = {
    manual: false,
    files: [manifest, lock],
    extraFiles: [],
    body: "",
    stale: false,
    checks: { state: "green", names: [] },
  };
  expect(decideRelease(input)).toMatchObject({ kind: "hold", reason: "files", immediate: true });
});

function fake(opts: { releases: string[]; contains: (tag: string) => boolean; towercab?: string }) {
  const calls: string[] = [];
  const github: GitHub = {
    me: "owner",
    owner: async () => failResult("no"),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "b", id: 1, email: "x" }),
    gh: async (_repo, args) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      calls.push(path);
      if (path.includes("/contents/release-please-config.json")) return okResult("{}");
      if (path.includes("/contents/TOWERCAB.md"))
        return opts.towercab === undefined ? failResult("HTTP 404: Not Found") : failResult(opts.towercab);
      if (path.includes("/pulls?")) return okResult("[]");
      if (path.includes("/releases?")) {
        return okResult(
          JSON.stringify(
            opts.releases.map((t, n) => ({
              tag_name: t,
              html_url: `https://x/${t}`,
              created_at: `2026-10-${String(n + 1).padStart(2, "0")}T00:00:00Z`,
            })),
          ),
        );
      }
      const cmp = /compare\/[^.]+\.\.\.(.+)$/.exec(path);
      if (cmp) return okResult(JSON.stringify({ status: opts.contains(cmp[1]!) ? "ahead" : "behind" }));
      return failResult("unhandled");
    },
  };
  return { github, calls };
}

function finishedMission(db: ReturnType<typeof testDb>): Mission {
  const m = insertMission(db, { intent: "i1", slug: "x", repo: "web", model: "m", a: 5 }, NOW);
  db.run("UPDATE missions SET stage = 'done', merge_sha = 'abc' WHERE id = ?", m.id);
  return m;
}

test("ship: published lookup asks GitHub once per new release, not every minute", async () => {
  const db = testDb();
  finishedMission(db);
  const tags = Array.from({ length: 20 }, (_, n) => `v1.${n}.0`);
  const { github, calls } = fake({ releases: tags, contains: () => false });
  const config = testConfig();
  for (let n = 0; n < 5; n++) await runReleases({ github, db, config, now: NOW + n * 60, log: () => {} });
  expect(calls.filter((c) => c.includes("/compare/"))).toHaveLength(1);
});

test("ship: published lookup finds the first release with few calls", async () => {
  const db = testDb();
  const m = finishedMission(db);
  const tags = Array.from({ length: 20 }, (_, n) => `v1.${n}.0`);
  const { github, calls } = fake({ releases: tags, contains: (t) => Number(t.split(".")[1]) >= 7 });
  await runReleases({ github, db, config: testConfig(), now: NOW, log: () => {} });
  const row = db.get<Mission>("SELECT * FROM missions WHERE id = ?", m.id)!;
  expect(JSON.parse(row.data).release.tag).toBe("v1.7.0");
  expect(calls.filter((c) => c.includes("/compare/")).length).toBeLessThanOrEqual(6);
});

test("ship: a failed read is an error, not a repo without release-please", async () => {
  const db = testDb();
  db.setMeta("releasing:web", "1");
  const row = {
    github: "owner/web",
    pr: 7,
    reason: "files",
    since: NOW,
    immediate: true,
    why: "w",
    title: "needs you",
    refusals: 0,
  };
  db.setMeta("release:web", JSON.stringify(row));
  const github: GitHub = {
    me: "owner",
    owner: async () => failResult("no"),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "b", id: 1, email: "x" }),
    gh: async () => failResult("HTTP 502: Bad Gateway"),
  };
  const failure = await runReleases({ github, db, config: testConfig(), now: NOW + 60, log: () => {} });
  expect(failure).toContain("502");
  expect(db.meta("releasing:web")).toBe("1");
  expect(heldReleases(db, NOW + 60)).toHaveLength(1);
  expect(heldReleases(db, NOW + 60)[0]!.since).toBe(NOW);
});

test("ship: a failed TOWERCAB.md read never merges a release", async () => {
  const db = testDb();
  const f = fake({ releases: [], contains: () => false, towercab: "HTTP 500: boom" });
  // Drive a release PR into the fake: the pulls list returns one PR, so wrap it.
  const base = f.github.gh;
  const calls: string[][] = [];
  const github: GitHub = {
    ...f.github,
    gh: async (repo, args, o) => {
      calls.push(args);
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (path.includes("/pulls?"))
        return okResult(
          JSON.stringify([
            { number: 7, body: "", user: { login: "github-actions[bot]" }, head: { sha: "p" } },
          ]),
        );
      return base(repo, args, o);
    },
  };
  const failure = await runReleases({ github, db, config: testConfig(), now: NOW, log: () => {} });
  expect(failure).not.toBeNull();
  expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(false);
});
