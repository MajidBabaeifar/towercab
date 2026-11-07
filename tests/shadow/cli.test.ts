// LOOP-131 and LOOP-130 through the real command line and the real loop.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../../src/cli.ts";
import { Db } from "../../src/db.ts";
import { Loop } from "../../src/loop.ts";
import { intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, tempDir } from "../helpers/world.ts";

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

test("cli: shadow reset and status", async () => {
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${bareRepo({ "intents/.keep": "" })}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const home = join(dir, "home");
  const g = ["--config", config, "--home", home];
  const t = new FakeTools();
  expect(await main([...g, "shadow", "status"], t)).toBe(0);
  expect(out).toContain("The shadow is off");
  expect(out).toContain("Today: $0.00 of $5.00.");
  // A conversation, an action and a session in the home's database.
  const db = new Db(join(home, "towercab.db"));
  db.run("INSERT INTO shadow_turns (at, role, text) VALUES (1, 'owner', 'hello')");
  db.run("INSERT INTO shadow_actions (at, action, intent, outcome) VALUES (1, 'start', 'i-1', 'done')");
  db.setMeta("shadow.session", "abc");
  db.setMeta("shadow.started", "1");
  out = "";
  expect(await main([...g, "shadow", "status"], t)).toBe(0);
  expect(out).toContain("Conversation: 1 messages, session started");
  out = "";
  expect(await main([...g, "shadow", "reset"], t)).toBe(0);
  expect(out).toContain("cleared; its action log is kept");
  expect(db.all("SELECT * FROM shadow_turns")).toEqual([]);
  expect(db.meta("shadow.session")).toBeNull();
  expect(db.all("SELECT * FROM shadow_actions")).toHaveLength(1);
  expect(await main([...g, "shadow", "frobnicate"], t)).toBe(2);
  db.close();
});

test("loop: a shadow turn does not block a pass", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  await p.start({}, {});
  let passes = 0;
  let busy = true;
  const loop = new Loop(
    {
      ...p.loop.d,
      shadow: {
        pass: async () => void passes++,
        busy: () => busy,
        stop: async () => {},
      },
    },
    { watch: true },
  );
  await loop.open();
  // A turn is running: the pass comes back at once, calls the shadow, and the loop isn't idle.
  const r = await loop.pass();
  expect(passes).toBe(1);
  expect(r.idle).toBe(false);
  busy = false;
  await loop.pass();
  expect(passes).toBe(2);
});
