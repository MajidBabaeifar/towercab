// REPO-31: restore never writes rulesets when it cannot read the current ones.

import { afterEach, beforeEach, expect, test } from "vitest";
import { settingsCommand } from "../../src/cli.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { failResult } from "../helpers/tools.ts";
import { checkThenApply, ghHandler, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

test("cli: settings restore skips rulesets it cannot read", async () => {
  const s = await settingsRig();
  await checkThenApply(s);
  const real = ghHandler(s.gh);
  const writes: string[][] = [];
  s.r.tools.on("gh", (args, opts) => {
    if (args[1] === "repos/owner/web/rulesets" && !args.includes("-X"))
      return failResult("gh: Server Error (HTTP 500)");
    if (args.includes("-X") && String(args[1]).includes("/rulesets")) writes.push(args);
    return real(args, opts);
  });
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  const out = await settingsCommand(w, ["restore", "web"]);
  expect(out).toContain("Could not read the current rulesets");
  expect(out).toContain("rulesets left as they are");
  expect(out).toContain("Restored the repository settings");
  expect(writes).toEqual([]);
});
