// The command line (LOOP-15).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { COMMANDS, main } from "../src/cli.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

function setup(): { config: string; home: string } {
  const intents = bareRepo({ "intents/.keep": "" });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${intents}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  return { config, home: join(dir, "home") };
}

test("cli: commands", async () => {
  const t = new FakeTools().on("systemctl", () => okResult());
  expect(await main(["--version"], t)).toBe(0);
  expect(out).toMatch(/^towercab \d+\.\d+\.\d+/);
  expect(await main([], t)).toBe(2);
  expect(await main(["frobnicate"], t)).toBe(2);
  expect(err).toContain("unknown command frobnicate");
  expect(await main(["--bogus"], t)).toBe(2);

  const { config, home } = setup();
  const g = ["--config", config, "--home", home];
  expect(await main([...g, "add", "web: Log in with a magic link", "u4", "i5"], t)).toBe(0);
  const id = /^(\d{6}-\d{4}) intents\/\S+-log-in-with-a-magic-link\/intent\.md$/m.exec(out)?.[1];
  expect(id).toBeTruthy();
  expect(await main([...g, "add", "no colon here"], t)).toBe(2);
  expect(await main([...g, "add", "web: x", "u9"], t)).toBe(1);
  expect(err).toContain('bad score "u9"');

  out = "";
  expect(await main([...g, "next"], t)).toBe(0);
  expect(out).toContain(`next: ${id} web: Log in with a magic link`);
  expect(await main([...g, "pause"], t)).toBe(0);
  expect(out).toContain("paused");
  expect(await main([...g, "resume"], t)).toBe(0);
  expect(await main([...g, "answer", id!, "yes"], t)).toBe(0);
  expect(out).toContain(`answer: ${id} isn't waiting on you`);
  expect(await main([...g, "approve", id!], t)).toBe(1);
  expect(err).toContain("isn't waiting for a merge");
  expect(await main([...g, "drop", id!], t)).toBe(0);
  expect(out).toContain(`dropped ${id}`);
  out = "";
  expect(await main([...g, "status"], t)).toBe(0);
  expect(out).toMatch(/towercab \S+ .*· not running/);
  for (const c of [
    "up",
    "down",
    "restart",
    "logs",
    "run",
    "status",
    "next",
    "add",
    "answer",
    "retry",
    "drop",
    "start",
    "approve",
    "pause",
    "resume",
    "ui",
    "doctor",
    "update",
  ]) {
    expect(COMMANDS).toContain(c);
  }
});

test("ui: the ui command", async () => {
  const t = new FakeTools();
  const { config, home } = setup();
  writeFileSync(config, `${readFileSync(config, "utf8")}\n[ui]\nport = 0\n`);
  expect(await main(["--config", config, "--home", home, "ui", "--no-open"], t)).toBe(1);
  expect(err).toContain("ui is off: [ui] port = 0");
  // With a loop holding the home, the command opens its page.
  const { config: c2, home: h2 } = setup();
  writeFileSync(c2, `${readFileSync(c2, "utf8")}\n[ui]\nport = 7399\n`);
  mkdirSync(h2, { recursive: true });
  writeFileSync(join(h2, "towercab.lock"), `${process.pid}\n`);
  t.on("xdg-open", () => okResult());
  out = "";
  expect(await main(["--config", c2, "--home", h2, "ui"], t)).toBe(0);
  expect(out.trim()).toBe("http://localhost:7399/");
  expect(t.lines("xdg-open")).toEqual(["http://localhost:7399/"]);
});

test("cli: doctor --quick leaves the database alone", async () => {
  const t = new FakeTools();
  const { config, home } = setup();
  // The self-update check runs new code before it is accepted: no migration, no import.
  await main(["--config", config, "--home", home, "doctor", "--quick"], t);
  expect(out).toContain(`config: ${config}`);
  expect(existsSync(join(home, "towercab.db"))).toBe(false);
});

test("cli: repo commands", async () => {
  const t = new FakeTools();
  const { config, home } = setup();
  const g = ["--config", config, "--home", home];
  // The config's [repos.web] is imported on the first command.
  expect(await main([...g, "repo", "list"], t)).toBe(0);
  expect(out.trim()).toBe(`web: owner/web · base main · 1 worker · ahead 3 · ${join(home, "repos", "web")}`);
  // add: the App's key is missing, so GitHub can't be reached; nothing is stored.
  expect(await main([...g, "repo", "add", "owner/api"], t)).toBe(1);
  expect(err).toBe(`towercab: Towercab can't reach owner/api: ${join(config, "..", "app.pem")}: missing\n`);
  err = "";
  expect(await main([...g, "repo", "add", "api"], t)).toBe(1);
  expect(err).toBe("towercab: api isn't a GitHub repo: write it as owner/name\n");
  out = "";
  expect(await main([...g, "repo", "set", "web", "workers=2", "env=FOO=bar"], t)).toBe(0);
  expect(out.trim()).toBe(
    `set web: owner/web · base main · 2 workers · ahead 3 · ${join(home, "repos", "web")} · env FOO`,
  );
  err = "";
  expect(await main([...g, "repo", "set", "web", "workers=99"], t)).toBe(1);
  expect(err).toBe("towercab: workers must be an integer 1-16\n");
  expect(await main([...g, "repo", "set", "web"], t)).toBe(2);
  out = "";
  expect(await main([...g, "repo", "remove", "web"], t)).toBe(0);
  expect(out).toBe("removed web (owner/web); its clone stays on disk\n");
  // Removed for good: the config table is not imported again.
  out = "";
  expect(await main([...g, "repo", "list"], t)).toBe(0);
  expect(out).toBe("no repos yet: add one with towercab repo add <owner/name>\n");
  err = "";
  expect(await main([...g, "repo", "remove", "web"], t)).toBe(1);
  expect(err).toBe("towercab: web isn't a repo Towercab knows (towercab repo list)\n");
  expect(await main([...g, "repo"], t)).toBe(2);
  expect(await main([...g, "repo", "add"], t)).toBe(2);
});

test("cli: start", async () => {
  const t = new FakeTools();
  const { config, home } = setup();
  const g = ["--config", config, "--home", home];
  expect(await main([...g, "add", "web: Log in with a magic link"], t)).toBe(0);
  const id = /^(\d{6}-\d{4}) /m.exec(out)?.[1] ?? "";
  out = "";
  expect(await main([...g, "start", id], t)).toBe(0);
  expect(out).toContain(`starting ${id}`);
  // A second start is refused the same way.
  out = "";
  expect(await main([...g, "start", id], t)).toBe(0);
  expect(out).toContain(`${id} has already started`);
  expect(await main([...g, "start"], t)).toBe(2);
  expect(await main([...g, "start", "000000-0000"], t)).toBe(0);
  expect(out).toMatch(/start: /);
});
