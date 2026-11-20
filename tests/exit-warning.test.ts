// LOOP-76: an exit that would close an open code PR with commits asks for one confirmation first.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../src/cli.ts";
import { applyCommand, insertCommand } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { confirmExit, exitWarning } from "../src/exit-warning.ts";
import type { Intent, IntentStore } from "../src/intents/types.ts";
import { apply, wait } from "../src/machine.ts";
import { insertMission, unfinishedFor } from "../src/mission.ts";
import { withCommits } from "./helpers/commits.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

const ID = "261026-1000";
const REPO = "owner/web";

/** A mission at `no changes` after a repair round: its code PR is open with `commits` commits. */
async function world(commits: number | null) {
  const db = Db.memory();
  const now = 1_793_000_000;
  const forge = withCommits(new FakeForge(), {});
  const n =
    commits === null ? null : await forge.openPr(REPO, { base: "main", head: "b", title: "t", body: "" });
  if (n !== null) withCommits(forge, { [`${REPO}#${n}`]: commits! });
  const store = {
    get: async () => ({ id: ID, stage: null, waiting: "no changes" }) as Intent,
    update: async () => ({}) as Intent,
  } as unknown as IntentStore;
  const applyCtx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  db.tx(() => insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 3 }, now));
  db.run("UPDATE missions SET stage = 'build', pr = ? WHERE intent = ?", n, ID);
  apply(applyCtx, unfinishedFor(db, ID)!, wait("no changes"));
  const d = { db, store, forge, githubOf: () => REPO };
  const run = (name: "done" | "steps" | "drop") =>
    applyCommand(
      { db, store, applyCtx, now: new Date(now * 1000) },
      {
        id: insertCommand(db, { name, arg: ID, text: "", source: "cli" }, now),
        name,
        arg: ID,
        text: "",
        source: "cli",
        created: now,
        applied_at: null,
        result: null,
      },
    );
  return { db, d, forge, run, n };
}

test("cli: done at no changes after a repair round asks to confirm the open PR", async () => {
  const w = await world(3);
  await expect(confirmExit(w.d, ID, false)).rejects.toThrow(
    `This closes PR #${w.n} (3 commits) and deletes its branch. Nothing is merged.\nRun it again with --yes to go on.`,
  );
  // Nothing moved while it waited for the answer.
  expect(unfinishedFor(w.db, ID)?.waiting).toBe("no changes");
  // With --yes it goes on and the intent ends done.
  await confirmExit(w.d, ID, true);
  expect(await w.run("done")).toContain("is done");
  expect(unfinishedFor(w.db, ID)).toBeUndefined();
});

test("cli: steps and drop confirm an open PR with commits", async () => {
  const w = await world(1);
  // One commit is "1 commit", and the same check guards steps and drop.
  const ask = confirmExit(w.d, ID, false);
  await expect(ask).rejects.toThrow(`PR #${w.n} (1 commit)`);
  const w2 = await world(5);
  await expect(confirmExit(w2.d, ID, false)).rejects.toThrow("(5 commits)");
});

test("cli: done without a PR needs no confirmation", async () => {
  const none = await world(null);
  await expect(confirmExit(none.d, ID, false)).resolves.toBeUndefined();
  // A PR with no commits beyond its base loses nothing either.
  const empty = await world(0);
  await expect(confirmExit(empty.d, ID, false)).resolves.toBeUndefined();
  expect(await exitWarning(empty.forge, REPO, empty.n)).toBeNull();
  // A PR that is already merged or closed is not closed again.
  const closed = await world(2);
  closed.forge.prs[0]!.state = "MERGED";
  expect(await exitWarning(closed.forge, REPO, closed.n)).toBeNull();
});

test("cli: an unreadable PR gets a general warning and a confirm", async () => {
  const w = await world(3);
  Object.assign(w.forge, {
    prCommits: async () => {
      throw new Error("GitHub is down");
    },
  });
  const warning = await exitWarning(w.forge, REPO, w.n);
  expect(warning).toEqual({
    pr: w.n,
    commits: null,
    text: "Couldn't check the PR; it may have commits. It will be closed and its branch deleted.",
  });
  // It is not refused: the confirm is asked, and --yes goes through.
  await expect(confirmExit(w.d, ID, false)).rejects.toThrow("Couldn't check the PR; it may have commits");
  await expect(confirmExit(w.d, ID, true)).resolves.toBeUndefined();
});

test("cli: --yes is accepted by done, steps and drop", async () => {
  const t = new FakeTools().on("systemctl", () => okResult());
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${bareRepo({ "intents/.keep": "" })}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const g = ["--config", config, "--home", join(dir, "home")];
  for (const c of ["done", "steps", "drop"]) {
    // No such intent has a mission: the flag is taken, and nothing asks.
    expect(await main([...g, c, "261026-1000", "--yes"], t)).not.toBe(2);
  }
});
