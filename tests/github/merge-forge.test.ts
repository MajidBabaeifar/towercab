// `GitHubForge`: the merge flag per method and the merge settings a repo allows (LOOP-153, LOOP-154).

import { expect, test } from "vitest";
import { GitHubForge } from "../../src/github/forge.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { fakeGitHub } from "./fakes.ts";

function world(answer: (args: string[]) => ReturnType<typeof okResult>) {
  const tools = new FakeTools().on("gh", (args) => answer(args));
  return { forge: new GitHubForge(fakeGitHub(tools)), lines: () => tools.lines("gh") };
}

test("forge: mergePr maps each method to its flag", async () => {
  const w = world(() => okResult());
  await w.forge.mergePr("me/web", 1, { method: "squash" });
  await w.forge.mergePr("me/web", 2, { method: "rebase", head: "h" });
  expect(w.lines()).toEqual([
    "pr merge 1 --squash -R me/web",
    "pr merge 2 --rebase --match-head-commit h -R me/web",
  ]);
});

test("forge: allowedMergeMethods reads the repo's merge settings", async () => {
  const body = (s: boolean, m: boolean, r: boolean) =>
    JSON.stringify({ allow_squash_merge: s, allow_merge_commit: m, allow_rebase_merge: r });
  expect(await world(() => okResult(body(false, true, true))).forge.allowedMergeMethods("me/web")).toEqual([
    "merge",
    "rebase",
  ]);
  expect(await world(() => okResult(body(false, false, false))).forge.allowedMergeMethods("me/web")).toEqual(
    [],
  );
  const w = world(() => okResult(body(true, false, false)));
  expect(await w.forge.allowedMergeMethods("me/web")).toEqual(["squash"]);
  expect(w.lines()).toEqual(["api repos/me/web"]);
  // Unreadable: no permission, not JSON, or JSON without the settings.
  expect(await world(() => failResult("HTTP 404")).forge.allowedMergeMethods("me/web")).toBeNull();
  expect(await world(() => okResult("<html>")).forge.allowedMergeMethods("me/web")).toBeNull();
  expect(await world(() => okResult("{}")).forge.allowedMergeMethods("me/web")).toBeNull();
});
