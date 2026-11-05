// A repo that needs a teammate's review on the page (UI-168), and the owner's buttons there (PIP-143, PIP-144).

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import type { GitHub } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { createActions } from "../../src/ui/actions.ts";
import { teammateView } from "../../src/ui/repos.ts";
import { missionCard, onTeammates, stateOf, teammateWords } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, MemStore } from "../../ui/fixture.ts";
import { TestClock, testConfig } from "../helpers/world.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});

const mission = (p: Partial<Mission>): Mission =>
  ({
    id: 1,
    intent: "261026-0900-1",
    repo: "web",
    attempt: 1,
    stage: "approval:merge",
    step: "",
    from_stage: null,
    waiting: "review and merge PR",
    why: null,
    continued: 0,
    busy: 0,
    unclean: 0,
    held: 0,
    model: "opus",
    a_at_pick: null,
    session: "s",
    session_used: 0,
    checkout: "work/x",
    branch: "towercab/x",
    base_sha: null,
    head: null,
    spec_pr: null,
    plan_pr: null,
    pr: 5,
    pushed_at: null,
    feedback_seen: null,
    merged_by: null,
    merge_sha: null,
    repairs: 0,
    ci_repairs: 0,
    retries: 0,
    retry_at: null,
    limit_model: null,
    step_secs: 0,
    child_pid: null,
    child_kind: null,
    child_since: null,
    child_model: null,
    cost_usd: 0,
    agent_secs: 0,
    data: "{}",
    created: 0,
    updated: 0,
    finished: null,
    ...p,
  }) as Mission;

test("ui: a card shows the teammate review wait", () => {
  const f = buildFixture({ now: NOW });
  open.push(f);
  const waiting = mission({ waiting: "teammate review" });
  expect(onTeammates(waiting)).toBe(true);
  expect(onTeammates(mission({}))).toBe(false);
  // Not waiting for the owner: a working state, not "needs you".
  expect(stateOf(waiting, NOW).key).toBe("working");
  expect(stateOf(mission({}), NOW).key).toBe("needs");
  // With no list the words say the code owners; with one, the names.
  expect(teammateWords(testConfig(), waiting)).toBe("Waiting for teammate review: the code owners");
  const config = testConfig();
  config.repos.set("web", { ...config.repos.get("web")!, teammateReview: true, reviewers: ["alice", "bob"] });
  expect(teammateWords(config, waiting)).toBe("Waiting for teammate review: alice, bob");
  // The card's own ask is plain.
  const card = missionCard(f.sources, waiting, undefined, null, NOW);
  expect(card.ask).toMatch(/^Your teammates need to approve this change/);
});

test("ui: pass on button raises passed_on", async () => {
  const f = buildFixture({ now: NOW });
  open.push(f);
  const passing = mission({ data: JSON.stringify({ teammate: { passNeeded: true } }) });
  const card = missionCard(f.sources, passing, undefined, null, NOW);
  // The change the review didn't approve: pass it on instead of merging it.
  expect(card.actions).toEqual(["pass", "retry", "drop"]);
  expect(card.mergeLabel).toBeNull();
  expect(missionCard(f.sources, mission({}), undefined, null, NOW).actions).toContain("merge");

  // The button writes the same `/pass` comment the owner can write, as the owner.
  const db = Db.memory();
  const calls: string[][] = [];
  const github: Pick<GitHub, "owner"> = {
    owner: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null }),
        stderr: "",
        timedOut: false,
      };
    },
  };
  const actions = createActions({
    db,
    store: new MemStore(),
    config: testConfig(),
    clock: new TestClock(),
    github,
  });
  const add = (intent: string, waiting: string, data: object) =>
    db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, data, created, updated)
       VALUES (?, 'web', 1, 'approval:merge', ?, 'opus', 's', 'w', 'b', 57, ?, 0, 0)`,
      intent,
      waiting,
      JSON.stringify(data),
    );
  add("a-pass", "review and merge PR", { teammate: { passNeeded: true } });
  expect(await actions.pass!("a-pass")).toMatch(/^Passed on/);
  expect(calls).toContainEqual(["pr", "comment", "57", "-R", "owner/web", "--body", "/pass"]);
  // Nothing to pass on where the teammates already have it, or the review approved.
  add("b-waiting", "teammate review", {});
  await expect(actions.pass!("b-waiting")).rejects.toThrow("Nothing to pass on");
  add("c-plain", "review and merge PR", {});
  await expect(actions.pass!("c-plain")).rejects.toThrow("Nothing to pass on");
});

test("pipeline: merge and approve are refused before the teammates approved", async () => {
  const db = Db.memory();
  const calls: string[][] = [];
  const github: Pick<GitHub, "owner"> = {
    owner: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ state: "OPEN", mergedAt: null }),
        stderr: "",
        timedOut: false,
      };
    },
  };
  const config = testConfig();
  config.repos.set("web", { ...config.repos.get("web")!, teammateReview: true, reviewers: ["alice"] });
  const actions = createActions({ db, store: new MemStore(), config, clock: new TestClock(), github });
  const add = (intent: string, waiting: string, data: object) =>
    db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, data, created, updated)
       VALUES (?, 'web', 1, 'approval:merge', ?, 'opus', 's', 'w', 'b', 57, ?, 0, 0)`,
      intent,
      waiting,
      JSON.stringify(data),
    );
  add("a-team", "teammate review", {});
  await expect(actions.merge("a-team")).rejects.toThrow(
    "Waiting for teammate review (alice): you can merge once they have approved.",
  );
  add("b-pass", "review and merge PR", { teammate: { passNeeded: true } });
  await expect(actions.merge("b-pass")).rejects.toThrow("Pass it on to your teammates first");
  // Nothing was sent to GitHub for either.
  expect(calls.some((c) => c[1] === "merge")).toBe(false);
  // Once the teammates approved the wait is the usual one: the owner's Merge works as everywhere else.
  add("c-ready", "review and merge PR", {});
  expect(await actions.merge("c-ready")).toMatch(/^Merged the code PR #57 as you/);
  expect(calls.some((c) => c[1] === "merge")).toBe(true);
});

test("ui: the warning shows on the card and the repo page", () => {
  const f = buildFixture({ now: NOW });
  open.push(f);
  const warning =
    "GitHub needs 2 approvals and your reviewers can give 1: add reviewers with towercab repo set web reviewers=…";
  const m = mission({ waiting: "teammate review", data: JSON.stringify({ reviewWarning: warning }) });
  expect(missionCard(f.sources, m, undefined, null, NOW).warning).toBe(warning);
  expect(missionCard(f.sources, mission({}), undefined, null, NOW).warning).toBeUndefined();
});

test("ui: the repo page shows the reviewers and the host's extra demand", () => {
  const f = buildFixture({ now: NOW });
  open.push(f);
  expect(teammateView(f.sources, "web", ["alice"])).toEqual({ reviewers: ["alice"], warning: null });
  f.sources.db.setMeta("required:web", "100 2");
  expect(teammateView(f.sources, "web", ["alice"]).warning).toBe(
    "GitHub needs 2 approvals and your reviewers can give 1: add reviewers with towercab repo set web reviewers=…",
  );
  expect(teammateView(f.sources, "web", ["alice", "bob"]).warning).toBeNull();
  // An unreadable rule, or no list (code owners may supply the rest), warns nothing here.
  f.sources.db.setMeta("required:web", "100 ?");
  expect(teammateView(f.sources, "web", ["alice"]).warning).toBeNull();
  f.sources.db.setMeta("required:web", "100 2");
  expect(teammateView(f.sources, "web", []).warning).toBeNull();
});
