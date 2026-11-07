// REPO-31: restore keeps going and reports when a read or a write fails, and reads the repo's own rulesets.

import { afterEach, beforeEach, expect, test } from "vitest";
import { settingsCommand } from "../../src/cli.ts";
import { newestBackup } from "../../src/settings/backup.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { checkThenApply, ghHandler, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

test("repo: restore lists a failed read and still restores the rest", async () => {
  const s = await settingsRig();
  await checkThenApply(s);
  const real = ghHandler(s.gh);
  s.r.tools.on("gh", (args, opts) =>
    args[1] === "repos/owner/web/rulesets" ? failResult("gh: Server Error (HTTP 500)") : real(args, opts),
  );
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  const out = await settingsCommand(w, ["restore", "web"]);
  expect(out).toContain("Could not read the current rulesets");
  expect(out).toContain("Restored the repository settings");
  expect(out).toContain("Restored branch protection of main");
});

test("repo: a refused restore still shows what was restored before it", async () => {
  const s = await settingsRig();
  await checkThenApply(s);
  const real = ghHandler(s.gh);
  s.r.tools.on("gh", (args, opts) =>
    args.includes("PUT") && String(args[1]).includes("branches")
      ? failResult("gh: Resource not accessible by integration (HTTP 403)")
      : real(args, opts),
  );
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  await expect(settingsCommand(w, ["restore", "web"])).rejects.toThrow(
    /Restored the repository settings[\s\S]*login can't change this repo's settings/,
  );
});

test("repo: rulesets are read page by page and only the repo's own are kept", async () => {
  const s = await settingsRig();
  const real = ghHandler(s.gh);
  const lines = [
    { id: 1, name: "main rules", source_type: "Repository" },
    { id: 9, name: "org rules", source_type: "Organization" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  s.r.tools.on("gh", (args, opts) => {
    if (args[1] === "repos/owner/web/rulesets") {
      expect(args).toContain("--paginate");
      return okResult(lines);
    }
    return real(args, opts);
  });
  await checkThenApply(s);
  expect(newestBackup(s.deps, s.web)!.rulesets.map((r) => r.id)).toEqual([1]);
});
