// Safety of the GitLab loop: the merge is pinned to the judged head, hosts don't share identities, and a
// GitLab-only install keeps working (GL-14, GL-15, GL-16).

import { expect, test } from "vitest";
import { AFTER, gitlabLoop, PUSH } from "../helpers/gitlab-loop.ts";

test("gitlab: the merge after an approval carries the head it judged", async () => {
  const l = await gitlabLoop();
  const m = l.gl.mr("group/web");
  l.gl.versions.set(m.iid, [PUSH]);
  m.approvedBy.push("owner");
  l.gl.approvedAt.set(`${m.iid}:owner`, AFTER);
  l.wait({ stage: "approval:merge", waiting: "review and merge PR", pr: m.iid });
  await l.pass(1);
  const merge = l.gl.requests.find((r) => r.path.endsWith("/merge"))!;
  expect(JSON.parse(merge.body).sha).toBe(m.sha);
});

test("gitlab: a stranger named like the other host's owner is not the owner", async () => {
  // Code on GitHub (owner `owner`), plan on GitLab (owner `gl-owner`): a GitLab user `owner` is a stranger.
  const l = await gitlabLoop({ code: "github", intents: "gitlab", me: "gl-owner" });
  const m = l.gl.mr("group/intents");
  l.gl.versions.set(m.iid, [PUSH]);
  m.approvedBy.push("owner");
  l.gl.approvedAt.set(`${m.iid}:owner`, AFTER);
  l.gl.note(m, "owner", "Please change this.", { created_at: "2026-11-05T09:00:00Z" });
  l.wait({ stage: "approval:plan", waiting: "approve plan", plan_pr: m.iid });
  await l.pass(3);
  expect(m.state).toBe("opened");
  expect(l.events()).not.toContain("feedback");
});

test("gitlab: a GitLab-only install with a GitLab intents repo keeps working", async () => {
  const l = await gitlabLoop({ code: "gitlab", intents: "gitlab" });
  // GitHub refuses everything, as with no [github].
  l.p.forge.bot = () => Promise.reject(new Error("repo add needs [github] (app_id, me)"));
  await l.pass(3);
  expect(l.p.logs.filter((x) => /proposed intents failed/.test(x))).toEqual([]);
});
