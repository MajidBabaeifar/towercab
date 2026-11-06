// `GitHubForge.jobLog` reads one job's own log through `gh api` (PIP-154).

import { expect, test } from "vitest";
import { GitHubForge } from "../../src/github/forge.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { fakeGitHub } from "./fakes.ts";

test("forge: jobLog reads the job's own log through the api", async () => {
  const tools = new FakeTools().on("gh", (args) =>
    args[0] === "api" && args[1] === "repos/me/web/actions/jobs/7/logs"
      ? okResult("the finding\n")
      : failResult("HTTP 404"),
  );
  const forge = new GitHubForge(fakeGitHub(tools));
  expect(await forge.jobLog("me/web", 7)).toBe("the finding\n");
  expect(tools.lines("gh")).toEqual(["api repos/me/web/actions/jobs/7/logs"]);
  await expect(forge.jobLog("me/web", 8)).rejects.toThrow("HTTP 404");
});
