// `GitLabHost` answers the `Forge` the stages call (GL-13).

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { GitLabHost, mergeStateOf } from "../../src/forge/gitlab-host.ts";
import { gitlabConfig } from "../helpers/gitlab.ts";
import { FakeGitLabLists } from "../helpers/gitlab-lists.ts";

const SLUG = "gitlab:group/web";

function world() {
  const gl = new FakeGitLabLists();
  gl.project("group/web");
  return { gl, host: new GitLabHost(new GitLabForge(gitlabConfig().cfg, gl.http)) };
}

test("gitlab: a merge request's status is read in the merge stage's words", async () => {
  expect(["mergeable", "need_rebase", "conflict", "draft_status", "ci_must_pass"].map(mergeStateOf)).toEqual([
    "CLEAN",
    "BEHIND",
    "DIRTY",
    "DRAFT",
    "BLOCKED",
  ]);
  const { gl, host } = world();
  const m = gl.mr("group/web", { detailed_merge_status: "need_rebase" });
  expect(await host.mergeStatus(SLUG, m.iid)).toMatchObject({
    state: "OPEN",
    mergeState: "BEHIND",
    head: m.sha,
  });
});

test("gitlab: a merge on a moved head is refused with GitLab's reason", async () => {
  const { gl, host } = world();
  const m = gl.mr("group/web");
  const r = await host.mergePr(SLUG, m.iid, { method: "squash", head: "f".repeat(40) });
  expect(r).toEqual({ ok: false, reason: "SHA does not match HEAD of source branch" });
  expect(m.state).toBe("opened");
  expect(await host.mergePr(SLUG, m.iid, { method: "squash", head: m.sha })).toEqual({
    ok: true,
    reason: "",
  });
  expect(m.state).toBe("merged");
});

test("gitlab: a branch is retired only when it is the bot's, closed and Towercab's", async () => {
  const { gl, host } = world();
  const own = gl.mr("group/web", { state: "closed", source_branch: "towercab/261001-0900-x" });
  const foreign = gl.mr("group/web", { state: "closed", source_branch: "feature" });
  expect(await host.retireBranch(SLUG, own.iid, null)).toBe("towercab/261001-0900-x");
  expect(await host.retireBranch(SLUG, foreign.iid, null)).toBeNull();
  expect(gl.calls()).toContain("DELETE /projects/group%2Fweb/repository/branches/towercab%2F261001-0900-x");
  await expect(host.deleteBranch(SLUG, "main", null)).rejects.toThrow(/not a Towercab branch/);
});

test("gitlab: what GitLab has no counterpart for answers neutrally", async () => {
  const { host } = world();
  expect(await host.codeScanningAlerts()).toEqual([]);
  expect(await host.listDeployments()).toEqual([]);
  expect(await host.readProposed()).toEqual([]);
  await expect(host.readSettings()).rejects.toThrow(/no settings script/);
});
