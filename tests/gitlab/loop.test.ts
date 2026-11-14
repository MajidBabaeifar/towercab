// The loop on GitLab (GL-13, GL-14, GL-16): merge requests are read through the routed host and move
// missions as pull requests do.

import { expect, test } from "vitest";
import { AFTER, gitlabLoop, PUSH } from "../helpers/gitlab-loop.ts";

/** A merge request of group/web the owner approved after the push. */
function approved(l: Awaited<ReturnType<typeof gitlabLoop>>, project = "group/web", user = "owner") {
  const m = l.gl.mr(project);
  l.gl.versions.set(m.iid, [PUSH]);
  m.approvedBy.push(user);
  l.gl.approvedAt.set(`${m.iid}:${user}`, AFTER);
  return m;
}

test("gitlab: the loop reads the merge request of a waiting mission", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web");
  l.gl.versions.set(m.iid, [PUSH]);
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(l.gl.calls()).toContain("GET /projects/group%2Fweb/merge_requests/1");
  expect(l.gl.calls()).toContain("GET /projects/group%2Fweb/merge_requests/1/approvals");
  expect(l.p.logs.filter((x) => /reading its PRs failed/.test(x))).toEqual([]);
});

test("gitlab: the owner's approval in the loop merges", async () => {
  const l = await gitlabLoop();
  const m = approved(l);
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(m.state).toBe("merged");
  expect(l.gl.calls()).toContain("PUT /projects/group%2Fweb/merge_requests/1/merge");
  expect(JSON.parse(l.gl.requests.find((r) => r.path.endsWith("/merge"))!.body)).toMatchObject({
    sha: m.sha,
    squash: true,
  });
});

test("gitlab: a mission on a GitLab repo reaches the merged state", async () => {
  const l = await gitlabLoop();
  const m = approved(l);
  const mission = l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(2);
  expect(m.state).toBe("merged");
  expect(l.mission(mission.id).stage).not.toBe("approval:merge");
  expect(l.events()).toContain("code_merged");
});

test("gitlab: a merged merge request moves the mission to merged", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web", { state: "merged", merge_commit_sha: "c".repeat(40) });
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(l.events()).toContain("code_merged");
});

test("gitlab: a closed merge request moves the mission to closed", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web", { state: "closed" });
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(l.events()).toContain("closed");
});

test("gitlab: an owner note in the loop becomes feedback", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web");
  l.gl.note(m, "owner", "Please use blue.", { created_at: "2026-11-05T09:00:00Z" });
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(l.events()).toContain("feedback");
  expect(JSON.stringify(l.p.db.all("SELECT data FROM missions"))).toContain("Please use blue.");
});

test("gitlab: /retry in the loop retries the mission", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web");
  l.gl.note(m, "owner", "/retry", { created_at: "2026-11-05T09:00:00Z" });
  l.wait({ stage: "blocked", waiting: "CI red", pr: m.iid });
  await l.pass(3);
  expect(l.events().some((e) => e.startsWith("retry"))).toBe(true);
});

test("gitlab: an unreadable merge request is not a closed one", async () => {
  const l = await gitlabLoop();
  const mission = l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: 99 });
  await l.pass(3);
  expect(l.events()).not.toContain("closed");
  expect(l.mission(mission.id).stage).toBe("approval:merge");
  expect(l.p.logs.some((x) => /reading its PRs failed.*404/.test(x))).toBe(true);
});

test("gitlab: a plan merge request on the intents project is merged by the loop", async () => {
  const l = await gitlabLoop({ intents: "gitlab" });
  const m = approved(l, "group/intents");
  l.wait({ stage: "approval:plan", waiting: "approve plan", plan_pr: m.iid });
  await l.pass(3);
  expect(m.state).toBe("merged");
  expect(l.gl.calls()).toContain("PUT /projects/group%2Fintents/merge_requests/1/merge");
});

test("gitlab: code on GitHub with intents on GitLab", async () => {
  // The owner is `gl-owner` on GitLab and `owner` on GitHub: the plan's approval counts all the same.
  const l = await gitlabLoop({ code: "github", intents: "gitlab", me: "gl-owner" });
  const m = approved(l, "group/intents", "gl-owner");
  l.wait({ stage: "approval:plan", waiting: "approve plan", plan_pr: m.iid });
  await l.pass(3);
  expect(m.state).toBe("merged");
  expect(l.gl.calls().filter((c) => c.includes("group%2Fweb"))).toEqual([]);
});

test("gitlab: code on GitLab with intents on GitHub", async () => {
  const l = await gitlabLoop({ code: "gitlab", intents: "github", me: "gl-owner" });
  const m = approved(l, "group/web", "gl-owner");
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(3);
  expect(m.state).toBe("merged");
  expect(l.gl.calls().filter((c) => c.includes("group%2Fintents"))).toEqual([]);
});
