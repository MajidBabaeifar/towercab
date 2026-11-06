// Merge requests as the pipeline reads and changes pull requests (GL-5, GL-6, GL-7).

import { expect, test } from "vitest";
import { GitLabForge, mergeStep } from "../../src/forge/gitlab.ts";
import { stageMarker } from "../../src/github/comments.ts";
import { approveRequested, prEvents } from "../../src/github/events.ts";
import { getMission, insertMission } from "../../src/mission.ts";
import { FakeGitLab, gitlabConfig } from "../helpers/gitlab.ts";
import { testDb } from "../helpers/world.ts";

const SLUG = "gitlab:group/sub/project";

function world() {
  const gl = new FakeGitLab();
  gl.project("group/sub/project");
  const f = new GitLabForge(gitlabConfig().cfg, gl.http);
  return { gl, f };
}

function mission(stage: string, cols: Record<string, string | number | null> = {}) {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  const all = { stage, step: "", ...cols };
  db.run(
    `UPDATE missions SET ${Object.keys(all)
      .map((k) => `${k} = ?`)
      .join(", ")} WHERE id = ?`,
    ...Object.values(all),
    m0.id,
  );
  return getMission(db, m0.id)!;
}

test("gitlab: opens a draft merge request", async () => {
  const { gl, f } = world();
  const r = await f.openPr(SLUG, { title: "Add things", body: "why", head: "feature", base: "main" });
  expect(r).toEqual({ number: 1, url: "https://gitlab.test/group/sub/project/-/merge_requests/1" });
  const m = gl.projects.get("group/sub/project")!.mrs[0]!;
  expect(m.title).toBe("Draft: Add things");
  expect(m.description).toBe("why");
  expect((await f.readPr(SLUG, 1)).isDraft).toBe(true);
});

test("gitlab: marks a merge request ready", async () => {
  const { gl, f } = world();
  gl.mr("group/sub/project", { title: "Draft: Add things" });
  await f.markReady(SLUG, 1);
  expect(gl.projects.get("group/sub/project")!.mrs[0]!.title).toBe("Add things");
  expect((await f.readPr(SLUG, 1)).isDraft).toBe(false);
});

test("gitlab: updates the description", async () => {
  const { gl, f } = world();
  gl.mr("group/sub/project");
  await f.setBody(SLUG, 1, "new text");
  expect((await f.readPr(SLUG, 1)).body).toBe("new text");
});

test("gitlab: edits its own stage comment by marker", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  expect(await f.upsertStageComment(SLUG, 1, "Build", 1, "first")).toEqual({ edited: false });
  expect(await f.upsertStageComment(SLUG, 1, "Build", 1, "second")).toEqual({ edited: true });
  expect(await f.upsertStageComment(SLUG, 1, "Build", 2, "other round")).toEqual({ edited: false });
  expect(m.notes).toHaveLength(2);
  expect(m.notes[0]!.body.startsWith(stageMarker("Build", 1))).toBe(true);
  expect(m.notes[0]!.body).toContain("second");
});

test("gitlab: a stage note names the agent and the intent", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  const by = { agent: "planner", intent: "261106-0530" };
  await f.upsertStageComment(SLUG, 1, "Question", 1, "which?", by);
  expect(m.notes[0]!.body.split("\n").slice(0, 2)).toEqual([
    stageMarker("Question", 1),
    "**Question** · planner · 261106-0530 · round 1",
  ]);
  // A note from before the header changed is still found by its marker and edited.
  expect(await f.upsertStageComment(SLUG, 1, "Question", 1, "again", by)).toEqual({ edited: true });
  expect(m.notes).toHaveLength(1);
});

test("gitlab: never edits a note it did not write", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  const theirs = gl.note(m, "someone-else", `${stageMarker("Build", 1)}\n**Build** · round 1\n\nfake`);
  expect(await f.upsertStageComment(SLUG, 1, "Build", 1, "mine")).toEqual({ edited: false });
  expect(theirs.body).toContain("fake");
  expect(m.notes).toHaveLength(2);
});

test("gitlab: merges on the gated head", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  expect((await f.merge(SLUG, 1, "d".repeat(40))).merged).toBe(false);
  expect(m.state).toBe("opened");
  expect(await f.merge(SLUG, 1, m.sha)).toEqual({ merged: true });
  const pr = await f.readPr(SLUG, 1);
  expect(pr.state).toBe("MERGED");
  expect(pr.mergeCommit).toBe("b".repeat(40));
  const put = gl.requests.find((r) => r.path.endsWith("/merge"))!;
  expect(JSON.parse(put.body)).toEqual({ sha: "d".repeat(40), squash: true });
});

test("gitlab: merge status maps to the pipeline's merge rules", () => {
  expect(mergeStep("mergeable")).toBe("merge");
  expect(mergeStep("need_rebase")).toBe("update");
  expect(mergeStep("conflict")).toBe("conflict");
  expect(mergeStep("draft_status")).toBe("ready");
  for (const s of ["ci_must_pass", "not_approved", "discussions_not_resolved", "checking"]) {
    expect(mergeStep(s)).toBe("wait");
  }
});

test("gitlab: closes a merge request", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  await f.closeIfOpen(SLUG, 1, "superseded");
  expect(m.state).toBe("closed");
  expect(m.notes.map((n) => n.body)).toEqual(["superseded"]);
  await f.closeIfOpen(SLUG, 1, "again");
  expect(m.notes).toHaveLength(1);
});

test("gitlab: paginates notes", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  for (let i = 0; i < 230; i++) gl.note(m, "someone", `n${i}`);
  gl.note(m, "towercab-bot", `${stageMarker("Build", 1)}\n**Build** · round 1\n\nold`);
  for (let i = 0; i < 20; i++) gl.note(m, "someone", `m${i}`);
  // The stage comment sits on the third page: it is found and edited, not posted again.
  expect(await f.upsertStageComment(SLUG, 1, "Build", 1, "new")).toEqual({ edited: true });
  expect(m.notes).toHaveLength(251);
});

test("gitlab: a merged merge request becomes merged", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  await f.merge(SLUG, 1, m.sha);
  const mi = mission("ci", { pr: 1, head: m.sha });
  expect(prEvents(mi, { code: await f.readPr(SLUG, 1) }, "owner", "towercab-bot")?.event).toBe("code_merged");
});

test("gitlab: a closed merge request becomes closed", async () => {
  const { gl, f } = world();
  gl.mr("group/sub/project", { state: "closed" });
  const mi = mission("ci", { pr: 1, head: "a".repeat(40) });
  expect(prEvents(mi, { code: await f.readPr(SLUG, 1) }, "owner", "towercab-bot")?.event).toBe("closed");
});

test("gitlab: an owner note is feedback", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  gl.note(m, "owner", "please rename it");
  const mi = mission("ci", { pr: 1, head: m.sha, feedback_seen: "2026-11-05T00:00:00Z" });
  const o = prEvents(mi, { code: await f.readPr(SLUG, 1) }, "owner", "towercab-bot");
  expect(o).toMatchObject({ event: "feedback", text: "please rename it" });
});

test("gitlab: an owner diff note is feedback with its line", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  gl.note(m, "owner", "why this?", { position: { new_path: "src/a.ts", new_line: 12 } });
  const mi = mission("ci", { pr: 1, head: m.sha, feedback_seen: "2026-11-05T00:00:00Z" });
  const pr = await f.readPr(SLUG, 1);
  expect(pr.comments[0]).toMatchObject({ path: "src/a.ts", line: 12 });
  expect(prEvents(mi, { code: pr }, "owner", "towercab-bot")).toMatchObject({
    event: "feedback",
    text: "src/a.ts:12: why this?",
  });
});

test("gitlab: system and bot notes are not feedback", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  gl.note(m, "owner", "added 1 commit", { system: true });
  gl.note(m, "towercab-bot", "a stage comment");
  const mi = mission("ci", { pr: 1, head: m.sha, feedback_seen: "2026-11-05T00:00:00Z" });
  const pr = await f.readPr(SLUG, 1);
  expect(pr.comments.map((c) => c.body)).toEqual(["a stage comment"]);
  expect(prEvents(mi, { code: pr }, "owner", "towercab-bot")).toBeNull();
});

test("gitlab: /retry works", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  gl.note(m, "owner", "/retry");
  const mi = mission("ci", { pr: 1, head: m.sha, feedback_seen: "2026-11-05T00:00:00Z" });
  expect(prEvents(mi, { code: await f.readPr(SLUG, 1) }, "owner", "towercab-bot")?.event).toBe("retry_fresh");
});

test("gitlab: a conflict is an event", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project", { has_conflicts: true, detailed_merge_status: "conflict" });
  const mi = mission("ci", { pr: 1, head: m.sha, feedback_seen: "2026-11-05T00:00:00Z" });
  const pr = await f.readPr(SLUG, 1);
  expect(pr.mergeable).toBe("CONFLICTING");
  expect(prEvents(mi, { code: pr }, "owner", "towercab-bot")?.event).toBe("conflict");
});

test("gitlab: the owner's approval merges", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  m.approvedBy.push("owner");
  const mi = mission("approval:merge", {
    pr: 1,
    head: m.sha,
    waiting: "review and merge PR",
    feedback_seen: "2026-11-05T00:00:00Z",
  });
  expect(approveRequested(mi, { code: await f.readPr(SLUG, 1) }, "owner")).toBe(1);
});

test("gitlab: an approval is the approved_by list", async () => {
  const { gl, f } = world();
  const m = gl.mr("group/sub/project");
  m.approvedBy.push("alice", "bob");
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews.map((r) => [r.author, r.state, r.commit])).toEqual([
    ["alice", "APPROVED", m.sha],
    ["bob", "APPROVED", m.sha],
  ]);
});

test("gitlab: no approvals on the project cannot meet teammate review", async () => {
  const { gl, f } = world();
  gl.mr("group/sub/project");
  gl.projects.get("group/sub/project")!.approvals = false;
  expect((await f.readPr(SLUG, 1)).reviews).toEqual([]);
});
