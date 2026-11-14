// An approval counts only if it came after the last push (GL-15, GL-7).

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { approveRequested, staleApprovalNotices } from "../../src/github/events.ts";
import { getMission, insertMission } from "../../src/mission.ts";
import { gitlabConfig } from "../helpers/gitlab.ts";
import { FakeGitLabTimes } from "../helpers/gitlab-times.ts";
import { testDb } from "../helpers/world.ts";

const SLUG = "gitlab:group/sub/project";
const PUSH = "2026-11-05T10:00:00Z";
const BEFORE = "2026-11-05T09:59:00Z";
const AFTER = "2026-11-05T10:01:00Z";

function world() {
  const gl = new FakeGitLabTimes();
  gl.project("group/sub/project");
  const m = gl.mr("group/sub/project");
  gl.versions.set(1, ["2026-11-05T09:00:00Z", PUSH]);
  const f = new GitLabForge(gitlabConfig().cfg, gl.http);
  return { gl, m, f };
}

function waiting() {
  const db = testDb();
  const m0 = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  db.run(
    "UPDATE missions SET stage = ?, step = '', pr = 1, waiting = ?, feedback_seen = ? WHERE id = ?",
    "approval:merge",
    "review and merge PR",
    "2026-11-05T00:00:00Z",
    m0.id,
  );
  return getMission(db, m0.id)!;
}

test("gitlab: an approval after the last push merges", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner");
  gl.approvedAt.set("1:owner", AFTER);
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews.map((r) => [r.author, r.at, r.commit])).toEqual([["owner", AFTER, null]]);
  expect(pr.staleApprovals).toBeUndefined();
  expect(approveRequested(waiting(), { code: pr }, "owner")).toBe(1);
});

test("gitlab: an approval before the last push does not merge", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner");
  gl.approvedAt.set("1:owner", BEFORE);
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews).toEqual([]);
  expect(pr.staleApprovals).toEqual([{ author: "owner", at: BEFORE, pushedAt: PUSH }]);
  expect(approveRequested(waiting(), { code: pr }, "owner")).toBeNull();
});

test("gitlab: an approval at the same time as the push does not merge", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner");
  gl.approvedAt.set("1:owner", PUSH);
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews).toEqual([]);
  expect(approveRequested(waiting(), { code: pr }, "owner")).toBeNull();
});

test("gitlab: an approval time falls back to the system note", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner", "alice");
  gl.note(m, "owner", "approved this merge request", { system: true, created_at: AFTER });
  gl.note(m, "alice", "approved this merge request", { system: true, created_at: BEFORE });
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews.map((r) => r.author)).toEqual(["owner"]);
  expect(pr.staleApprovals?.map((a) => a.author)).toEqual(["alice"]);
});

test("gitlab: an unreadable time does not count", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner");
  // No `approved_at` and no system note: the approval time is unknown.
  expect((await f.readPr(SLUG, 1)).reviews).toEqual([]);
  // The push time is unknown (versions unreadable): nothing counts either.
  gl.approvedAt.set("1:owner", AFTER);
  gl.versions.delete(1);
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews).toEqual([]);
  expect(pr.staleApprovals).toEqual([{ author: "owner", at: AFTER, pushedAt: "" }]);
});

test("gitlab: a stale approval is said in the stage comment", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("owner");
  gl.approvedAt.set("1:owner", BEFORE);
  const pr = await f.readPr(SLUG, 1);
  const asks = staleApprovalNotices(waiting(), { code: pr }, "towercab-bot");
  expect(asks).toHaveLength(1);
  expect(asks[0]!.text).toContain(`approval was given at ${BEFORE}, before the last push at ${PUSH}`);
  // Said once: a note by the bot carrying the marker answers it.
  const said = {
    ...pr,
    comments: [{ author: "towercab-bot", body: `${asks[0]!.marker}\n${asks[0]!.text}`, at: AFTER, id: "9" }],
  };
  expect(staleApprovalNotices(waiting(), { code: said }, "towercab-bot")).toEqual([]);
});

test("gitlab: an approval before the last push is stale", async () => {
  const { gl, m, f } = world();
  m.approvedBy.push("alice");
  gl.approvedAt.set("1:alice", BEFORE);
  const pr = await f.readPr(SLUG, 1);
  expect(pr.reviews.map((r) => r.author)).not.toContain("alice");
  expect(pr.staleApprovals?.map((a) => a.author)).toEqual(["alice"]);
});
