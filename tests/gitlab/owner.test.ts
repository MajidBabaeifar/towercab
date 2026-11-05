// The owner's own actions on GitLab run under their `glab` login (GL-8).

import { expect, test } from "vitest";
import { GlabOwner } from "../../src/forge/gitlab-owner.ts";
import { fakeGlab, gitlabConfig } from "../helpers/gitlab.ts";
import { FakeTools } from "../helpers/tools.ts";

function world(login = "owner") {
  const tools = new FakeTools();
  fakeGlab(tools, login);
  return { tools, owner: new GlabOwner(tools, gitlabConfig().cfg) };
}

test("gitlab: approve merges as the owner", async () => {
  const { tools, owner } = world();
  await owner.approve("gitlab:group/sub/project", 4, "a".repeat(40));
  expect(tools.lines("glab")).toEqual([
    "auth status --hostname gitlab.test",
    "mr approve 4 -R group/sub/project",
    `mr merge 4 -R group/sub/project --squash --sha ${"a".repeat(40)} --yes`,
  ]);
});

test("gitlab: a reply is a note by the owner", async () => {
  const { tools, owner } = world();
  await owner.reply("gitlab:group/sub/project", 4, "thanks");
  expect(tools.lines("glab").at(-1)).toBe("mr note 4 -R group/sub/project -m thanks");
  await owner.close("gitlab:group/sub/project", 4);
  expect(tools.lines("glab").at(-1)).toBe("mr close 4 -R group/sub/project");
  // The bot's token never reaches glab.
  for (const c of tools.calls.filter((c) => c.cmd === "glab")) {
    expect(Object.keys(c.opts.env ?? {})).not.toContain("TOWERCAB_GITLAB_TOKEN");
  }
});

test("gitlab: owner actions refuse another glab login", async () => {
  const { tools, owner } = world("someone-else");
  const why = "glab is not logged in as owner on gitlab.test: run glab auth login";
  await expect(owner.approve("gitlab:g/p", 1, "a")).rejects.toThrow(why);
  await expect(owner.reply("gitlab:g/p", 1, "x")).rejects.toThrow(why);
  expect(tools.lines("glab").every((l) => l.startsWith("auth status"))).toBe(true);
});
