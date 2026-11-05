// A repo that needs a teammate's review (LOOP-83), and what `doctor` says of it (LOOP-84).

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import type { GitHub } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import { loadRepos, readRepos, repoList, setRepo } from "../src/repos.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const T0 = 1_793_000_000;

function world() {
  const db = Db.memory();
  const config = testConfig({ github: { app_id: 1, me: "Owner" } });
  const home = new Home(tempDir("tc-home-"));
  loadRepos(config, db, T0);
  return { db, config, home };
}

test("repos: set teammate_review and reviewers", () => {
  const w = world();
  // Off by default, and a repo that never sets them carries neither.
  expect(w.config.repos.get("web")).not.toHaveProperty("teammateReview");
  expect(repoList(w.db, w.home.root)).not.toMatch(/teammate review/);
  const r = setRepo(w.db, w.config, "web", ["teammate_review=on", "reviewers=Alice, bob,alice"]);
  expect(r).toMatchObject({ teammateReview: true, reviewers: ["alice", "bob"] });
  expect(w.config.repos.get("web")).toMatchObject({ teammateReview: true, reviewers: ["alice", "bob"] });
  // The columns are in the table and the running loop's Map follows it (LOOP-68).
  expect(readRepos(w.db)[0]).toMatchObject({ teammateReview: true, reviewers: ["alice", "bob"] });
  // The list is kept while the setting is off.
  const off = setRepo(w.db, w.config, "web", ["teammate_review=off"]);
  expect(off.teammateReview).toBeUndefined();
  expect(off.reviewers).toEqual(["alice", "bob"]);
  // `reviewers=` empties it.
  expect(setRepo(w.db, w.config, "web", ["reviewers="]).reviewers).toBeUndefined();
  expect(() => setRepo(w.db, w.config, "web", ["teammate_review=yes"])).toThrow(
    "teammate_review must be on or off",
  );
  expect(() => setRepo(w.db, w.config, "web", ["reviewers=al ice"])).toThrow(
    "reviewers: al ice is not a login",
  );
  expect(() => setRepo(w.db, w.config, "web", ["reviewers=a/b"])).toThrow("reviewers: a/b is not a login");
  expect(() => setRepo(w.db, w.config, "web", [`reviewers=${"x".repeat(40)}`])).toThrow("is not a login");
  // One bad pair changes nothing.
  expect(() => setRepo(w.db, w.config, "web", ["teammate_review=on", "reviewers=?"])).toThrow();
  expect(w.config.repos.get("web")).not.toHaveProperty("teammateReview");
});

test("repos: reviewers refuses the owner and the bot", () => {
  const w = world();
  expect(() => setRepo(w.db, w.config, "web", ["reviewers=alice,owner"])).toThrow(
    "reviewers: owner is you: the owner cannot review their own change",
  );
  expect(() => setRepo(w.db, w.config, "web", ["reviewers=towercab"], "towercab[bot]")).toThrow(
    "reviewers: towercab is Towercab's bot",
  );
  expect(w.config.repos.get("web")).not.toHaveProperty("reviewers");
});

test("cli: repo list shows teammate review", () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["teammate_review=on"]);
  expect(repoList(w.db, w.home.root)).toMatch(/ · teammate review: CODEOWNERS$/);
  setRepo(w.db, w.config, "web", ["reviewers=alice,bob"]);
  expect(repoList(w.db, w.home.root)).toMatch(/ · teammate review: alice, bob$/);
  setRepo(w.db, w.config, "web", ["teammate_review=off"]);
  expect(repoList(w.db, w.home.root)).not.toMatch(/teammate review/);
});

/** A GitHub that answers the base branch's protection and rules, or fails them. */
function host(opts: { required?: number; protection?: "fail" }): GitHub {
  return {
    owner: async () => okResult("Logged in to github.com account Owner"),
    gh: async (_repo: string, args: string[]) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      if (path.endsWith("/protection")) {
        if (opts.protection === "fail" || opts.required === undefined) return failResult("HTTP 404");
        return okResult(
          JSON.stringify({
            required_pull_request_reviews: { required_approving_review_count: opts.required },
          }),
        );
      }
      return failResult("HTTP 404");
    },
  } as unknown as GitHub;
}

const lines = async (w: ReturnType<typeof world>, github: GitHub, quick = false) =>
  (await doctor({ config: w.config, home: w.home, tools: new FakeTools(), github, quick })).lines;

test("doctor: a required approval with teammate review off is a warning", async () => {
  const w = world();
  const out = await lines(w, host({ required: 1 }));
  expect(out).toContain(
    "web: GitHub requires 1 approval but teammate review is off: run towercab repo set web teammate_review=on reviewers=<logins>",
  );
  // The warning doesn't fail the check; and with the setting on it is gone.
  const res = await doctor({
    config: w.config,
    home: w.home,
    tools: new FakeTools(),
    github: host({ required: 2 }),
    quick: false,
  });
  expect(res.lines.some((l) => l.includes("teammate review is off"))).toBe(true);
  setRepo(w.db, w.config, "web", ["teammate_review=on"]);
  expect((await lines(w, host({ required: 1 }))).some((l) => l.includes("GitHub requires"))).toBe(false);
});

test("doctor: an unreadable branch protection is not a warning", async () => {
  const w = world();
  expect((await lines(w, host({ protection: "fail" }))).some((l) => l.includes("GitHub requires"))).toBe(
    false,
  );
  // No required approvals is nothing to warn about; --quick never asks GitHub.
  expect((await lines(w, host({ required: 0 }))).some((l) => l.includes("GitHub requires"))).toBe(false);
  expect((await lines(w, host({ required: 3 }), true)).some((l) => l.includes("GitHub requires"))).toBe(
    false,
  );
});

test("doctor: fewer listed reviewers than required approvals is a warning", async () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["teammate_review=on", "reviewers=alice"]);
  expect(await lines(w, host({ required: 2 }))).toContain(
    "web: GitHub requires 2 approvals but only 1 reviewers are listed: run towercab repo set web reviewers=…",
  );
  setRepo(w.db, w.config, "web", ["reviewers=alice,bob"]);
  expect((await lines(w, host({ required: 2 }))).some((l) => l.includes("reviewers are listed"))).toBe(false);
  // An empty list is not warned here: code owners may supply the reviewers (PIP-147 warns on the card).
  setRepo(w.db, w.config, "web", ["reviewers="]);
  expect((await lines(w, host({ required: 2 }))).some((l) => l.includes("reviewers are listed"))).toBe(false);
});
