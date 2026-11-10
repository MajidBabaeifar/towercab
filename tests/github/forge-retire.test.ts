// PIP-87..89 on the real code: `GitHubForge.retireBranch` over a fake `gh` deletes a branch only when
// the App's own PR on it was closed unmerged, it is a Towercab branch, and no other PR is open on it.

import { expect, test } from "vitest";
import { GitHubForge } from "../../src/github/forge.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { BOT, fakeGitHub } from "./fakes.ts";

interface View {
  state?: string;
  author?: string;
  headRefName?: string;
  isCrossRepository?: boolean;
}

function world(view: View, others: { number: number; state: string }[] = []) {
  const v = { state: "CLOSED", author: BOT, headRefName: "towercab/x", isCrossRepository: false, ...view };
  const tools = new FakeTools().on("gh", (args) => {
    if (args[0] === "pr" && args[1] === "view")
      return okResult(
        JSON.stringify({
          state: v.state,
          author: { login: v.author },
          headRefName: v.headRefName,
          isCrossRepository: v.isCrossRepository,
        }),
      );
    if (args[0] === "pr" && args[1] === "list")
      return okResult(JSON.stringify(others.map((o) => ({ ...o, author: { login: BOT } }))));
    return okResult();
  });
  const forge = new GitHubForge(fakeGitHub(tools));
  const deletes = () => tools.lines("gh").filter((l) => l.includes("DELETE"));
  return { forge, deletes };
}

test("forge: retireBranch deletes the branch of the App's own closed PR", async () => {
  const w = world({}, [{ number: 1, state: "CLOSED" }]);
  expect(await w.forge.retireBranch("me/web", 1, null)).toBe("towercab/x");
  expect(w.deletes()).toEqual(["api -X DELETE repos/me/web/git/refs/heads/towercab/x"]);
});

test("forge: retireBranch leaves an open, merged or fork PR's branch", async () => {
  for (const view of [{ state: "OPEN" }, { state: "MERGED" }, { isCrossRepository: true }]) {
    const w = world(view);
    expect(await w.forge.retireBranch("me/web", 1, null)).toBeNull();
    expect(w.deletes()).toEqual([]);
  }
});

test("forge: retireBranch leaves a branch outside towercab/ or a PR someone else opened", async () => {
  for (const view of [{ headRefName: "feature/x" }, { headRefName: "main" }, { author: "somebody-else" }]) {
    const w = world(view);
    expect(await w.forge.retireBranch("me/web", 1, null)).toBeNull();
    expect(w.deletes()).toEqual([]);
  }
  // `plan/` branches are Towercab's only in the intents repo.
  const plan = world({ headRefName: "plan/x" });
  expect(await plan.forge.retireBranch("me/web", 1, null)).toBeNull();
  expect(await plan.forge.retireBranch("me/intents", 1, "me/intents")).toBe("plan/x");
});

test("forge: retireBranch leaves a branch another open PR still uses", async () => {
  const w = world({}, [
    { number: 1, state: "CLOSED" },
    { number: 2, state: "OPEN" },
  ]);
  expect(await w.forge.retireBranch("me/web", 1, null)).toBeNull();
  expect(w.deletes()).toEqual([]);
});
