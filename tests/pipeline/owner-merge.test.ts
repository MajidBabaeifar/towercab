// PIP-144: the owner's own merge (the page's Merge, `towercab approve`) in a repo that needs a teammate's
// review is refused until a teammate approved, also where the gate never ran its teammate check.

import { expect, test } from "vitest";
import type { RepoConfig } from "../../src/config.ts";
import type { GitHub } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { ownerMergeRefusal, PASS_FIRST } from "../../src/pipeline/teammate.ts";

const repo: RepoConfig = {
  name: "web",
  github: "owner/web",
  path: "",
  base: "main",
  workers: 1,
  ahead: 3,
  env: {},
  teammateReview: true,
  reviewers: ["alice"],
};

const mission = (stage: string, data: object = {}): Mission =>
  ({ stage, pr: 7, spec_pr: 6, branch: "b", data: JSON.stringify(data) }) as unknown as Mission;

/** The owner's `gh`, where PR 7 and 6 have these reviews (and every `api` read fails). */
function owner(reviews: { who: string; state: string }[]): { run: GitHub["owner"]; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitHub["owner"] = async (args) => {
    calls.push(args);
    if (args[0] === "pr") {
      const view = {
        state: "OPEN",
        headRefOid: "h1",
        mergeable: "MERGEABLE",
        isDraft: false,
        body: "",
        comments: [],
        author: { login: "towercab[bot]" },
        reviewDecision: "",
        baseRefName: "main",
        reviews: reviews.map((r) => ({
          author: { login: r.who },
          state: r.state,
          body: "",
          submittedAt: "2026-11-05T10:00:00Z",
          commit: { oid: "h1" },
        })),
      };
      return { code: 0, stdout: JSON.stringify(view), stderr: "", timedOut: false };
    }
    // The review comments are read as a list; everything else (CODEOWNERS, files, reviews) is unreadable.
    if (args.some((x) => x.includes("/comments?")))
      return { code: 0, stdout: "[]", stderr: "", timedOut: false };
    return { code: 1, stdout: "", stderr: "HTTP 404", timedOut: false };
  };
  return { run, calls };
}

const refuse = (o: ReturnType<typeof owner>, m: Mission, r: RepoConfig = repo) =>
  ownerMergeRefusal({ owner: o.run, me: "owner", repo: r, m });

test("pipeline: the owner's merge needs the pass-on first", async () => {
  const o = owner([]);
  expect(await refuse(o, mission("approval:merge", { teammate: { passNeeded: true } }))).toBe(PASS_FIRST);
  expect(o.calls).toHaveLength(0);
});

test("pipeline: the owner's merge is refused where the gate skipped the teammate check", async () => {
  const none = owner([]);
  const m = mission("approval:merge", { teammate: { unchecked: true } });
  expect(await refuse(none, m)).toBe(
    "A teammate has not approved yet (alice): you can merge once they have.",
  );
  // The owner's own approval never counts; a listed reviewer's does.
  expect(await refuse(owner([{ who: "owner", state: "APPROVED" }]), m)).toMatch(/has not approved yet/);
  expect(await refuse(owner([{ who: "alice", state: "APPROVED" }]), m)).toBeNull();
});

test("pipeline: the owner's merge of a spec PR checks for a teammate approval", async () => {
  const m = mission("approval:spec");
  expect(await refuse(owner([]), m)).toMatch(/has not approved yet/);
  expect(await refuse(owner([{ who: "alice", state: "APPROVED" }]), m)).toBeNull();
});

test("pipeline: the owner's merge is untouched where no teammate review is needed", async () => {
  const o = owner([]);
  // A checked code PR (the gate already waited for the teammates), a plan PR, and a repo without the setting.
  expect(await refuse(o, mission("approval:merge", { teammate: { unchecked: false } }))).toBeNull();
  expect(await refuse(o, mission("approval:plan"))).toBeNull();
  expect(await refuse(o, mission("approval:spec"), { ...repo, teammateReview: false })).toBeNull();
  expect(o.calls).toHaveLength(0);
});

test("pipeline: the owner's merge is refused when the PR can't be read", async () => {
  const broken: GitHub["owner"] = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
  const m = mission("approval:merge", { teammate: { unchecked: true } });
  expect(await ownerMergeRefusal({ owner: broken, me: "owner", repo, m })).toMatch(
    /can't tell whether a teammate approved/,
  );
});
