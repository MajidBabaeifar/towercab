// The CLI's side of LOOP-15: one loop per home, and commands applied by the CLI itself when no loop
// runs. (`commands: applied by the loop` is in loop.test.ts.)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { Db } from "../src/db.ts";
import { Home } from "../src/home.ts";
import { insertMission } from "../src/mission.ts";
import { intent } from "./helpers/flows.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";

const ID = "261026-1000";

function world(intents: Record<string, string>) {
  const dir = tempDir("tc-cli-");
  const home = join(dir, "home");
  const bare = bareRepo(intents);
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${bare}"\n[github]\napp_id = 1\nme = "owner"\n[repos.web]\ngithub = "owner/web"\n`,
  );
  return { home, bare, config, args: ["--config", config, "--home", home] };
}

const io = { out: [] as string[], err: [] as string[] };
function capture() {
  io.out = [];
  io.err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    io.out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    io.err.push(String(s));
    return true;
  });
}

afterEach(() => vi.restoreAllMocks());

test("cli: second run is refused", async () => {
  const w = world({ "README.md": "intents\n" });
  // Another live process holds this home's lock.
  const home = Home.resolve(w.home);
  writeFileSync(home.lockPath, `${process.ppid}\n`);
  capture();
  expect(await main([...w.args, "run"], new FakeTools())).toBe(1);
  expect(io.err.join("")).toBe(`towercab: towercab is running (pid ${process.ppid}): towercab down first\n`);
  expect(home.holder()).toBe(process.ppid);
});

test("commands: applied without a loop", async () => {
  const w = world({
    [`intents/${ID}-t/intent.md`]: intent({ title: "T" }),
    "intents/261026-1001-u/intent.md": intent({ title: "U", extra: "waiting: answer the question\n" }),
  });
  // A mission waiting on the owner, from an earlier run.
  const home = Home.resolve(w.home);
  const db = new Db(home.db);
  const m = insertMission(db, { intent: ID, slug: "t", repo: "web", model: "opus", a: 5 }, 1);
  db.run(
    "UPDATE missions SET stage = 'blocked', step = '', waiting = 'answer the question', from_stage = 'build' WHERE id = ?",
    m.id,
  );
  db.close();
  capture();
  const tools = new FakeTools();
  expect(home.holder()).toBeNull();
  expect(await main([...w.args, "answer", ID, "Use", "blue."], tools)).toBe(0);
  expect(io.out.join("")).toBe(`answered ${ID}; it continues\n`);
  // An intent waiting with no mission: the answer goes into the file and the wait is lifted.
  expect(await main([...w.args, "answer", "1001", "Fine as is."], tools)).toBe(0);
  expect(await main([...w.args, "pause"], tools)).toBe(0);
  expect(io.out.slice(1).join("")).toBe(
    "answered 261026-1001\npaused: nothing new starts, and merges wait until you resume\n",
  );
  const after = new Db(home.db);
  const row = after.get<{ stage: string; waiting: string | null; data: string }>("SELECT * FROM missions")!;
  expect([row.stage, row.waiting, JSON.parse(row.data).answer]).toEqual(["build", null, "Use blue."]);
  expect(after.meta("paused")).toBe("1");
  expect(
    after.all<{ name: string; source: string; result: string }>(
      "SELECT name, source, result FROM commands WHERE applied_at IS NOT NULL ORDER BY id",
    ),
  ).toEqual([
    { name: "answer", source: "cli", result: `answered ${ID}; it continues` },
    { name: "answer", source: "cli", result: "answered 261026-1001" },
    { name: "pause", source: "cli", result: "paused: nothing new starts, and merges wait until you resume" },
  ]);
  after.close();
  // Both answers were written to the intents repo.
  const t = git(w.bare, "show", `main:intents/${ID}-t/intent.md`);
  expect(t).toMatch(/## Answers\n\n- .*: Use blue\./);
  const u = git(w.bare, "show", "main:intents/261026-1001-u/intent.md");
  expect(u).toMatch(/## Answers\n\n- .*: Fine as is\./);
  expect(u).not.toContain("waiting:");
});
