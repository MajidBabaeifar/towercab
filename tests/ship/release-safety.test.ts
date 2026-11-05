// SHIP-30..32 hardening, second review: a TOWERCAB.md that won't parse, and the lookup backlog.

import { expect, test } from "vitest";
import type { GitHub } from "../../src/handlers.ts";
import { insertMission, type Mission } from "../../src/mission.ts";
import { decideRelease, type ReleaseInput } from "../../src/ship/release.ts";
import { heldReleases, releaseLine, runReleases } from "../../src/ship/releases.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { testConfig, testDb } from "../helpers/world.ts";

const NOW = 1_793_000_000;
const patch = (...lines: string[]) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;

const input: ReleaseInput = {
  manual: false,
  files: [{ name: "CHANGELOG.md", patch: patch("+x") }],
  extraFiles: [],
  body: "",
  stale: false,
  checks: { state: "green", names: [] },
};

test("ship: an invalid TOWERCAB.md holds the release", () => {
  expect(decideRelease({ ...input, invalid: "releases must be auto or manual" })).toMatchObject({
    kind: "hold",
    reason: "manual",
    immediate: true,
  });
});

function github(towercab: string, calls: string[][], releases: unknown[] = []): GitHub {
  return {
    me: "owner",
    owner: async () => failResult("no"),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "b", id: 1, email: "x" }),
    gh: async (_repo, args) => {
      calls.push(args);
      if (args[0] === "pr") return okResult();
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (path.includes("/contents/release-please-config.json")) return okResult("{}");
      if (path.includes("/contents/TOWERCAB.md")) return okResult(towercab);
      if (path.includes("/pulls?"))
        return okResult(
          JSON.stringify([
            { number: 7, body: "", user: { login: "github-actions[bot]" }, head: { sha: "p" } },
          ]),
        );
      if (/\/commits\/main$/.test(path)) return okResult(JSON.stringify({ sha: "m" }));
      if (path.includes("/compare/m...p"))
        return okResult(JSON.stringify({ merge_base_commit: { sha: "m" } }));
      if (path.includes("/pulls/7/files"))
        return okResult(JSON.stringify([{ filename: "CHANGELOG.md", patch: patch("+x") }]));
      if (path.includes("/check-runs"))
        return okResult(
          JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }),
        );
      if (path.endsWith("/status")) return okResult(JSON.stringify({ statuses: [] }));
      if (path.includes("/required_status_checks")) return failResult("HTTP 404: Not Found");
      if (path.includes("/releases?")) return okResult(JSON.stringify(releases));
      if (path.includes("/compare/")) return okResult(JSON.stringify({ status: "behind" }));
      return failResult("unhandled");
    },
  };
}

test("ship: a mistyped releases value is never read as auto", async () => {
  const db = testDb();
  const calls: string[][] = [];
  await runReleases({
    github: github("---\nreleases: Manual\n---\n", calls),
    db,
    config: testConfig(),
    now: NOW,
    log: () => {},
  });
  expect(calls.some((c) => c[0] === "pr" && c[1] === "merge")).toBe(false);
  const [h] = heldReleases(db, NOW);
  expect(h).toMatchObject({ reason: "manual", card: true });
  expect(h!.why).toContain("releases must be auto or manual");
});

function finished(db: ReturnType<typeof testDb>, n: number): Mission[] {
  return Array.from({ length: n }, (_, i) => {
    const m = insertMission(db, { intent: `i${i}`, slug: "x", repo: "web", model: "m", a: 5 }, NOW);
    db.run("UPDATE missions SET stage = 'done', merge_sha = ? WHERE id = ?", `sha${i}`, m.id);
    return m;
  });
}

const release = (tag: string, day: number) => ({
  tag_name: tag,
  html_url: `https://x/${tag}`,
  created_at: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
});

test("ship: the published lookup works off a backlog a few missions per pass", async () => {
  const db = testDb();
  finished(db, 12);
  const calls: string[][] = [];
  const gh = github("", calls, [release("v1.0.0", 1)]);
  const config = testConfig();
  await runReleases({ github: gh, db, config, now: NOW, log: () => {} });
  const compares = () =>
    calls.filter((c) => (c.find((a) => a.startsWith("repos/")) ?? "").includes("/compare/sha"));
  expect(compares()).toHaveLength(5);
  await runReleases({ github: gh, db, config, now: NOW + 60, log: () => {} });
  await runReleases({ github: gh, db, config, now: NOW + 120, log: () => {} });
  expect(compares()).toHaveLength(12);
});

test("ship: a merge older than every release read shows no wrong tag", async () => {
  const db = testDb();
  const [m] = finished(db, 1);
  const releases = Array.from({ length: 100 }, (_, n) => release(`v1.${n}.0`, (n % 28) + 1));
  const gh: GitHub = {
    ...github("", [], releases),
    gh: async (repo, args, o) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (path.includes("/compare/sha")) return okResult(JSON.stringify({ status: "ahead" }));
      return github("", [], releases).gh(repo, args, o);
    },
  };
  await runReleases({ github: gh, db, config: testConfig(), now: NOW, log: () => {} });
  const row = db.get<Mission>("SELECT * FROM missions WHERE id = ?", m!.id)!;
  expect(releaseLine(db, row)).toBeNull();
});
