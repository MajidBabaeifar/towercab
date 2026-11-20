// LOOP-122: the refusal of `repo add` keeps the install steps of the missing App install.

import { expect, test } from "vitest";
import { AppNotInstalled } from "../src/github/app.ts";
import { beginAddRepo } from "../src/repos.ts";
import { FakeTools } from "./helpers/tools.ts";
import { tempDir, testConfig, testDb } from "./helpers/world.ts";

test("repos: add carries the install help in its refusal", async () => {
  const help = {
    app: "Towercab Bot",
    url: "https://github.com/apps/towercab/installations/new",
    steps: ["Open it."],
  };
  const config = testConfig();
  const e = await beginAddRepo(
    {
      config,
      db: testDb(),
      tools: new FakeTools(),
      home: tempDir(),
      now: 1_800_000_000,
      source: "cli",
      github: {
        repoInfo: () => Promise.reject(new AppNotInstalled("me/web", help)),
        gitAuth: () => Promise.reject(new Error("unused")),
      },
    },
    "me/web",
  ).catch((x: unknown) => x);
  expect((e as Error).message).toBe("Towercab can't reach me/web: the GitHub App isn't installed on me/web");
  expect((e as Error & { help?: unknown }).help).toEqual(help);
});
