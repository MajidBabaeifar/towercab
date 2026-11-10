// What the observer proposes (OBV-4..7, OBV-11, OBV-12), through a whole run over fakes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openProposal, proposalBranch } from "../../src/observer/propose.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { git } from "../helpers/world.ts";
import { at, listing } from "../intents/fixtures.ts";
import { finding, local, ObsRig, proposedPr } from "./rig.ts";

/** The intent file the run's `n`th proposal put on its branch. */
function proposalFile(r: ObsRig, run: number, n: number): string {
  const branch = `refs/heads/${proposalBranch(run, n)}`;
  const file = git(r.intents, "ls-tree", "-r", "--name-only", branch)
    .split("\n")
    .find((p) => p.endsWith("/intent.md"))!;
  return git(r.intents, "show", `${branch}:${file}`);
}

const TITLES = [
  "Towercab stops retrying a check that fails the same way every time",
  "Towercab shows why a build waited so long for a free slot",
  "Towercab asks one clear question instead of three vague ones",
  "Towercab explains what a rollback changed in plain words",
  "Towercab warns before a run that usually costs far too much",
];

test("observer: a finding becomes one proposed intent PR", async () => {
  const r = new ObsRig();
  r.child([finding()]);
  await r.run(r.observer());
  expect(r.created).toHaveLength(1);
  const args = r.created[0]!;
  expect(args[args.indexOf("--head") + 1]).toBe("observer/1-0");
  expect(args[args.indexOf("--base") + 1]).toBe("main");
  expect(args[args.indexOf("-R") + 1]).toBe("owner/intents");
  const text = proposalFile(r, 1, 0);
  expect(text).toContain("repo: web\n");
  expect(r.runs()[0]!.proposals).toBe(1);
  expect(r.db.all("SELECT pr FROM observer_proposals")).toEqual([{ pr: 7 }]);
});

test("observer: a CI finding is proposed for the ci repo", async () => {
  const r = new ObsRig();
  r.child([finding({ title: "The ci repo gives its slow checks a longer time limit", repo: "ci" })]);
  await r.run(r.observer());
  expect(proposalFile(r, 1, 0)).toContain("repo: ci\n");
});

test("observer: a flaky test is proposed for the repo that has it", async () => {
  const r = new ObsRig();
  r.mission("i-3", "ci");
  r.child([
    finding({
      title: "The web repo fixes the test that fails one run in four",
      repo: "web",
      evidence: [
        { id: "i-1", shows: "the test failed" },
        { id: "i-3", shows: "it passed on the rerun" },
      ],
    }),
  ]);
  await r.run(r.observer());
  expect(proposalFile(r, 1, 0)).toContain("repo: web\n");
});

test("observer: a finding for an unknown repo is dropped", async () => {
  const r = new ObsRig();
  r.child([finding({ repo: "nowhere" })]);
  await r.run(r.observer());
  expect(r.created).toEqual([]);
  expect(r.runs()[0]!.dropped).toContain("unknown repo");
});

test("observer: the intent has source observer", async () => {
  const r = new ObsRig();
  r.child([finding()]);
  await r.run(r.observer());
  const text = proposalFile(r, 1, 0);
  expect(text).toContain("source: observer\n");
  expect(text).not.toContain("source: me");
});

test("observer: autonomy is capped at a4", async () => {
  const r = new ObsRig();
  r.child([finding({ a: 5, u: 2, i: 4 })]);
  await r.run(r.observer());
  const text = proposalFile(r, 1, 0);
  expect(text).toContain("a: 4\n");
  expect(text).toContain("u: 2\n");
  expect(text).toContain("i: 4\n");
});

test("observer: a closed proposal is not proposed again without new evidence", async () => {
  const r = new ObsRig();
  r.child([finding()])
    .child([finding()])
    .child([
      finding({
        evidence: [
          { id: "i-1", shows: "failed twice" },
          { id: "i-5", shows: "and again today" },
        ],
      }),
    ]);
  const o = r.observer();
  await r.run(o);
  expect(r.created).toHaveLength(1);
  // The owner closed it: it is no longer among the open proposals. The same evidence changes nothing.
  r.clock.t = local(2026, 11, 10, 6, 5);
  await r.run(o);
  expect(r.created).toHaveLength(1);
  expect(r.runs()[1]!.dropped).toContain("closed");
  // New evidence brings it back.
  r.mission("i-5", "web");
  r.clock.t = local(2026, 11, 11, 6, 5);
  await r.run(o);
  expect(r.created).toHaveLength(2);
});

test("observer: a proposal lists its evidence and expected gain", async () => {
  const r = new ObsRig();
  r.child([finding()]);
  await r.run(r.observer());
  const text = proposalFile(r, 1, 0);
  expect(text).toContain("### Evidence");
  expect(text).toContain("- `i-1`: failed twice");
  expect(text).toContain("- `i-2`: failed three times");
  expect(text).toContain("### Expected gain\n\nAbout 2 fewer repairs per intent.");
  expect(text.indexOf("## Problem")).toBeLessThan(text.indexOf("## Proposed outcome"));
});

test("observer: a finding that overlaps an open proposal adds a comment", async () => {
  const r = new ObsRig();
  r.proposed = [proposedPr(12, "Towercab stops retrying a check that fails the same way")];
  r.child([finding({ overlaps: ["12"] })]);
  await r.run(r.observer());
  expect(r.created).toEqual([]);
  expect(r.comments).toHaveLength(1);
  const c = r.comments[0]!;
  expect(c.args).toContain("12");
  expect(c.args[c.args.indexOf("-R") + 1]).toBe("owner/intents");
  expect(c.text).toContain("`i-2`: failed three times");
  expect(r.runs()[0]!.comments).toBe(1);
});

test("observer: a finding that overlaps a running intent goes in the report", async () => {
  const r = new ObsRig();
  const title = "Towercab retries failing checks smartly";
  r.listing = listing([at("intents/260901-0900-retry-checks", "stage: build\n", "web", title)]);
  r.child([finding({ overlaps: ["260901-0900"] })]);
  await r.run(r.observer());
  expect(r.created).toEqual([]);
  expect(r.comments).toEqual([]);
  expect(
    r
      .outbox()
      .map((m) => m.text)
      .join("\n"),
  ).toContain("Seen again");
});

test("observer: an identical title is not proposed twice", async () => {
  const r = new ObsRig();
  const title = "Towercab stops retrying a check that fails the same way every time!";
  r.listing = listing([at("intents/260901-0900-retry-checks", "stage: spec\n", "web", title)]);
  r.child([finding()]);
  await r.run(r.observer());
  expect(r.created).toEqual([]);
});

test("observer: a comment is posted once per run", async () => {
  const r = new ObsRig();
  r.proposed = [proposedPr(12, "Retries that never help")];
  r.child([
    finding({ overlaps: ["12"] }),
    finding({ title: "Towercab skips the retries that never help a failing check", overlaps: ["12"] }),
  ]);
  await r.run(r.observer());
  expect(r.comments).toHaveLength(1);
});

test("observer: at most three proposals in seven days", async () => {
  const r = new ObsRig();
  r.child(TITLES.map((title) => finding({ title })));
  r.child([finding({ title: "Towercab names the repo a failing check belongs to" })]);
  const o = r.observer();
  await r.run(o);
  expect(r.created).toHaveLength(3);
  expect(JSON.parse(r.runs()[0]!.detail).held).toHaveLength(2);
  // Three are used for the week, so the next day adds none.
  r.clock.t = local(2026, 11, 10, 6, 5);
  await r.run(o);
  expect(r.created).toHaveLength(3);
});

test("observer: the best ranked findings use the room", async () => {
  const r = new ObsRig();
  r.child([
    finding({ title: TITLES[0]!, u: 1, i: 1 }),
    finding({ title: TITLES[1]!, u: 5, i: 5 }),
    finding({ title: TITLES[2]!, u: 3, i: 3 }),
    finding({ title: TITLES[3]!, u: 4, i: 5 }),
  ]);
  await r.run(r.observer());
  expect(r.created).toHaveLength(3);
  const held = JSON.parse(r.runs()[0]!.detail).held as { title: string }[];
  expect(held.map((h) => h.title)).toEqual([TITLES[0]]);
});

test("observer: comments do not count toward the limit", async () => {
  const r = new ObsRig();
  r.proposed = [proposedPr(12, "Retries that never help")];
  r.child([finding({ overlaps: ["12"] }), ...TITLES.slice(0, 3).map((title) => finding({ title }))]);
  await r.run(r.observer());
  expect(r.comments).toHaveLength(1);
  expect(r.created).toHaveLength(3);
});

test("observer: it opens, comments and reports and does nothing else", async () => {
  const r = new ObsRig();
  r.proposed = [proposedPr(12, "Retries that never help")];
  r.child([finding({ overlaps: ["12"] }), finding({ title: TITLES[1]! })]);
  await r.run(r.observer());
  const verbs = new Set(r.tools.lines("gh").map((l) => l.split(" ").slice(0, 2).join(" ")));
  expect([...verbs].sort()).toEqual(["pr comment", "pr create", "pr list"]);
  expect(r.created).toHaveLength(1);
  expect(r.comments).toHaveLength(1);
  expect(r.outbox().length).toBeGreaterThan(0);
});

test("observer: it never merges or edits an intent on main", async () => {
  const r = new ObsRig();
  r.child([finding(), finding({ title: TITLES[1]! })]);
  await r.run(r.observer());
  // Main of the intents repo is as it was seeded; the proposals live on their own branches.
  expect(git(r.intents, "log", "--format=%s", "main").trim().split("\n")).toEqual(["seed"]);
  const branches = git(r.intents, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  expect(branches.filter((b) => b.startsWith("observer/")).sort()).toEqual(["observer/1-0", "observer/1-1"]);
  // And no file of the observer reaches for a merge, a close or a write to an intent.
  const dir = join(import.meta.dirname, "..", "..", "src", "observer");
  for (const f of readdirSync(dir)) {
    const code = readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
    const forbidden = [".merge(", "mergePr", "markReady", "closePr", "store.update", "store.add"];
    for (const bad of forbidden) expect(code, `${f} uses ${bad}`).not.toContain(bad);
  }
});

test("observer: a replay after a crash opens no second PR", async () => {
  const r = new ObsRig();
  const deps = {
    config: r.config,
    home: r.home,
    tools: r.tools,
    github: fakeGitHub(r.tools),
    store: r.store(),
    now: r.clock.now(),
  };
  const taken = new Set<string>();
  const first = await openProposal(deps, 4, 0, finding(), null, taken);
  expect(first.existed).toBe(false);
  expect(r.created).toHaveLength(1);
  // The run crashed before it recorded the PR; the replay finds it on the branch.
  r.onBranch = JSON.stringify([{ number: first.pr, state: "OPEN", author: { login: "app/towercab" } }]);
  const again = await openProposal(deps, 4, 0, finding(), null, taken);
  expect(again).toMatchObject({ pr: first.pr, existed: true });
  expect(r.created).toHaveLength(1);
});
