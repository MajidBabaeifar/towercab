// The command line (LOOP-15).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
