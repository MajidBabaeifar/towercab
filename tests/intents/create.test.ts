// The one writer for a new intent, and adding text to an open one (INT-71, INT-72, INT-74).

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addToIntent, canAddTo, createIntent, type Draft } from "../../src/intents/create.ts";
import { openStore } from "../../src/intents/store.ts";
import { RefusedError } from "../../src/intents/types.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir } from "../helpers/world.ts";
import { ObsRig } from "../observer/rig.ts";
import { intentMd } from "./fixtures.ts";

const NOW = new Date(2026, 9, 21, 9, 5, 7);
const REPOS = { repos: new Map([["towercab", {} as never]]) };
const TITLE = "Towercab shows the owner a form for a new intent";

async function world(files: Record<string, string> = { "README.md": "intents\n" }) {
  const remote = bareRepo(files);
  const path = join(tempDir(), "intents");
  const store = await openStore({ remote, path, tools: new FakeTools(), log: () => {}, now: () => NOW });
  const d = { store, config: REPOS, now: () => NOW };
  return { remote, path, store, d };
}

const draft = (over: Partial<Draft> = {}): Draft => ({ repo: "towercab", title: TITLE, ...over });

test("intents: createIntent writes the same file as a hand-written intent", async () => {
  const w = await world();
  const made = await createIntent(w.d, draft({ u: 4, i: 5 }), "direct");
  expect(made).toMatchObject({
    id: "261021-0905",
    path: "intents/261021-0905-towercab-shows-the-owner-a-form-for-a-new-intent/intent.md",
  });
  const text = git(w.remote, "show", `main:${made.path}`);
  expect(text).toBe(
    `---\nrepo: towercab\nu: 4\ni: 5\nsource: me\nstarted: ${text.match(/started: (\S+)/)![1]}\n---\n\n# Intent: ${TITLE}\n`,
  );
  // The same file `towercab add` writes with those arguments.
  const again = await world();
  const viaStore = await again.store.add({ repo: "towercab", title: TITLE, u: 4, i: 5 }, NOW);
  expect(git(again.remote, "show", `main:${viaStore.dir}/intent.md`)).toBe(text);
});

test("intents: createIntent writes only the sections given", async () => {
  const w = await world();
  const made = await createIntent(
    w.d,
    draft({ problem: "Nothing helps.", constraints: "- Keep it small", questions: "  \n" }),
    "direct",
  );
  const text = git(w.remote, "show", `main:${made.path}`);
  expect(text).toContain(
    `# Intent: ${TITLE}\n\n## Problem\n\nNothing helps.\n\n## Constraints\n\n- Keep it small`,
  );
  expect(text).not.toContain("## Open questions");
  expect(text).not.toContain("## Proposed outcome");
  // A line starting with `#` can't open a heading of its own.
  const h = await createIntent(w.d, draft({ title: `${TITLE} twice`, problem: "# not a heading" }), "direct");
  expect(git(w.remote, "show", `main:${h.path}`)).toContain("\\# not a heading");
});

test("intents: createIntent leaves default scores out", async () => {
  const w = await world();
  const made = await createIntent(w.d, draft(), "direct");
  const text = git(w.remote, "show", `main:${made.path}`);
  expect(text).not.toMatch(/^[uia]:/m);
  expect(text).toContain("source: me\n");
});

test("intents: createIntent commits to main and pushes", async () => {
  const w = await world();
  const made = await createIntent(w.d, draft(), "direct");
  expect(git(w.remote, "log", "--format=%s", "main").split("\n")[0]).toBe(`towercab: add ${made.id}`);
  expect(git(w.remote, "branch", "--list").replace("*", "").trim()).toBe("main");
});

test("intents: a failed push leaves no folder", async () => {
  const w = await world();
  const hook = join(w.remote, "hooks/pre-receive");
  writeFileSync(hook, '#!/bin/sh\necho "test: push rejected" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await expect(createIntent(w.d, draft(), "direct")).rejects.toThrow();
  expect(existsSync(join(w.path, "intents"))).toBe(false);
  expect((await w.store.list()).open).toEqual([]);
});

test("intents: createIntent refuses an unknown repo", async () => {
  const w = await world();
  await expect(createIntent(w.d, draft({ repo: "nowhere" }), "direct")).rejects.toThrow(
    "nowhere is not one of Towercab's repos",
  );
  expect(git(w.remote, "log", "--format=%s", "main").trim().split("\n")).toHaveLength(1);
});

test("intents: createIntent refuses a bad score", async () => {
  const w = await world();
  for (const bad of [{ u: 0 }, { i: 6 }, { u: 2.5 }, { a: 6 }, { a: -1 }]) {
    await expect(createIntent(w.d, draft(bad), "direct")).rejects.toThrow(RefusedError);
  }
  // a0 is allowed for a direct write; a proposal stops at a4.
  await expect(createIntent(w.d, draft({ a: 5 }), "proposal")).rejects.toThrow("a must be an integer 0-4");
});

test("intents: createIntent refuses a title with markup or two lines", async () => {
  const w = await world();
  for (const title of ["a\nb", "x <b>y</b> z w", "a `code` title here", "", "   ", "word ".repeat(30)]) {
    await expect(createIntent(w.d, draft({ title }), "direct")).rejects.toThrow(RefusedError);
  }
  await expect(createIntent(w.d, draft({ problem: "x".repeat(20_001) }), "direct")).rejects.toThrow(
    "Problem is over 20000 characters",
  );
});

test("intents: createIntent keeps a title that breaks the naming rule", async () => {
  const w = await world();
  const made = await createIntent(w.d, draft({ title: "  Fix it  " }), "direct");
  expect(git(w.remote, "show", `main:${made.path}`)).toContain("# Intent: Fix it\n");
});

test("intents: a contributor's intent is a proposal PR with source proposal", async () => {
  const r = new ObsRig();
  const store = {
    github: () => "owner/intents",
    list: async () => (await import("./fixtures.ts")).listing([]),
  };
  const github = (await import("../github/fakes.ts")).fakeGitHub(r.tools);
  const d = {
    store: store as never,
    config: r.config,
    now: () => NOW,
    proposal: { config: r.config, home: r.home, tools: r.tools, github, who: "ben" },
  };
  const made = await createIntent(
    d,
    { repo: "web", title: TITLE, a: 3, problem: "Nothing helps." },
    "proposal",
  );
  expect(made).toMatchObject({ id: "261021-0905", proposal: true, pr: 7, path: "" });
  const args = r.created[0]!;
  expect(args[args.indexOf("--head") + 1]).toBe(
    `proposal/${"towercab-shows-the-owner-a-form-for-a-new-intent"}`,
  );
  const branch = "refs/heads/proposal/towercab-shows-the-owner-a-form-for-a-new-intent";
  const file = git(r.intents, "ls-tree", "-r", "--name-only", branch)
    .split("\n")
    .find((p) => p.endsWith("/intent.md"))!;
  const text = git(r.intents, "show", `${branch}:${file}`);
  expect(text).toContain("source: proposal\n");
  expect(text).toContain("a: 3\n");
  expect(text).toContain("## Problem\n\nNothing helps.");
  expect(args[args.indexOf("--title") + 1]).toBe(`docs(intents): add 261021-0905 ${TITLE}`);
});

test("intents: a proposal never reaches main before it is merged", async () => {
  const r = new ObsRig();
  const store = {
    github: () => "owner/intents",
    list: async () => (await import("./fixtures.ts")).listing([]),
  };
  const github = (await import("../github/fakes.ts")).fakeGitHub(r.tools);
  const d = {
    store: store as never,
    config: r.config,
    now: () => NOW,
    proposal: { config: r.config, home: r.home, tools: r.tools, github, who: "ben" },
  };
  await createIntent(d, { repo: "web", title: TITLE }, "proposal");
  expect(git(r.intents, "ls-tree", "-r", "--name-only", "main").trim()).toBe("README.md");
});

test("intents: a proposal's autonomy is capped at a4", async () => {
  const w = await world();
  await expect(createIntent(w.d, draft({ a: 5 }), "proposal")).rejects.toThrow("a must be an integer 0-4");
  await expect(createIntent(w.d, draft({ a: 4 }), "proposal")).rejects.toThrow("isn't on GitHub");
});

test("intents: a crash before the PR comment opens no second proposal", async () => {
  const r = new ObsRig();
  r.onBranch = JSON.stringify([{ number: 9, state: "OPEN", headRefName: "proposal/x", url: "u" }]);
  const store = {
    github: () => "owner/intents",
    list: async () => (await import("./fixtures.ts")).listing([]),
  };
  const github = (await import("../github/fakes.ts")).fakeGitHub(r.tools);
  const d = {
    store: store as never,
    config: r.config,
    now: () => NOW,
    proposal: { config: r.config, home: r.home, tools: r.tools, github, who: "ben" },
  };
  const made = await createIntent(d, { repo: "web", title: TITLE }, "proposal", "x");
  expect(made).toMatchObject({ proposal: true, pr: 9 });
  expect(r.created).toEqual([]);
});

const open = (extra = "", title = "Towercab greets visitors") =>
  `${intentMd("towercab", `u: 3\nsource: me\n${extra}`, title)}\n## Problem\n\nNo greeting.\n`;
const FILES = {
  "intents/261021-0900-greet/intent.md": open(),
  "intents/261021-0901-built/intent.md": open("stage: code\n", "Towercab builds it"),
  "done/261021-0902-old/intent.md": open("stage: done\n", "Towercab did it"),
};

test("intents: addToIntent appends to the matching sections", async () => {
  const w = await world(FILES);
  await addToIntent(
    w.d,
    "261021-0900",
    { repo: "x", title: "ignored", problem: "Also late.", outcome: "- Greets" },
    null,
    "owner via page",
  );
  const text = git(w.remote, "show", "main:intents/261021-0900-greet/intent.md");
  expect(text).toContain("## Problem\n\nNo greeting.\n\nAlso late.\n");
  expect(text).toContain("## Proposed outcome\n\n- Greets\n");
  expect(git(w.remote, "log", "--format=%B", "-1", "main")).toContain("Added-by: owner via page");
});

test("intents: addToIntent creates a missing section before the Towercab sections", async () => {
  const text = `${open("").replace(/\n$/, "")}\n\n## Towercab\n\n- note\n`;
  const w = await world({ "intents/261021-0900-greet/intent.md": text });
  await addToIntent(w.d, "261021-0900", { repo: "x", title: "t", constraints: "Keep it small" }, null, "me");
  const after = git(w.remote, "show", "main:intents/261021-0900-greet/intent.md");
  expect(after).toContain(
    "## Problem\n\nNo greeting.\n\n## Constraints\n\nKeep it small\n\n## Towercab\n\n- note\n",
  );
});

test("intents: addToIntent leaves the front matter alone", async () => {
  const w = await world(FILES);
  const before = git(w.remote, "show", "main:intents/261021-0900-greet/intent.md");
  await addToIntent(w.d, "261021-0900", { repo: "x", title: "t", problem: "More." }, null, "me");
  const after = git(w.remote, "show", "main:intents/261021-0900-greet/intent.md");
  expect(after.split("\n---\n")[0]).toBe(before.split("\n---\n")[0]);
  expect(after).toContain("# Intent: Towercab greets visitors\n");
});

test("intents: addToIntent refuses a done intent", async () => {
  const w = await world(FILES);
  await expect(
    addToIntent(w.d, "261021-0902", { repo: "x", title: "t", problem: "More." }, null, "me"),
  ).rejects.toThrow(
    "261021-0902 is done, so it can't take new text. Write a new intent instead and link 261021-0902 in it.",
  );
  await expect(
    addToIntent(w.d, "261021-9999", { repo: "x", title: "t", problem: "More." }, null, "me"),
  ).rejects.toThrow("no intent matches 261021-9999");
});

test("intents: addToIntent refuses an intent past design and says to write a new one", async () => {
  const w = await world(FILES);
  const head = git(w.remote, "rev-parse", "main");
  await expect(
    addToIntent(w.d, "261021-0901", { repo: "x", title: "t", problem: "More." }, null, "me"),
  ).rejects.toThrow(
    "261021-0901 is already past design, so new text would not change it. Write a new intent instead and link 261021-0901 in it.",
  );
  // A mission past design counts, even when the file has no stage yet.
  await expect(
    addToIntent(w.d, "261021-0900", { repo: "x", title: "t", problem: "More." }, { stage: "build" }, "me"),
  ).rejects.toThrow("already past design");
  expect(git(w.remote, "rev-parse", "main")).toBe(head);
  const l = await w.store.list();
  expect(canAddTo(l.open.find((i) => i.id === "261021-0900")!, { stage: "approval:spec" })).toBe(true);
  expect(canAddTo(l.open.find((i) => i.id === "261021-0901")!)).toBe(false);
});

test("intents: addToIntent refuses a contributor", async () => {
  const w = await world(FILES);
  const head = git(w.remote, "rev-parse", "main");
  await expect(
    addToIntent(w.d, "261021-0900", { repo: "x", title: "t", problem: "More." }, null, "ben", "proposal"),
  ).rejects.toThrow("only a maintainer can add text to an existing intent");
  expect(git(w.remote, "rev-parse", "main")).toBe(head);
});

test("intents: an addition is on the timeline", async () => {
  const w = await world(FILES);
  await addToIntent(w.d, "261021-0900", { repo: "x", title: "t", problem: "More." }, null, "Ana via page");
  const log = git(w.remote, "log", "--format=%s%n%b", "-1", "main");
  expect(log).toContain("towercab: add text to 261021-0900");
  expect(log).toContain("Added-by: Ana via page");
});
