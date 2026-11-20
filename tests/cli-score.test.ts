// The score command (LOOP-135): urgency and importance from the command line, applied by the CLI itself when
// no loop runs. Autonomy and Boost have no command.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

const ID = "261107-0900";
const FILE = `intents/${ID}-thing/intent.md`;

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

function setup(extra = "u: 3\ni: 3\n") {
  const remote = bareRepo({ [FILE]: intentMd("web", extra, "Thing") });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${remote}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const g = ["--config", config, "--home", join(dir, "home")];
  const text = () => git(remote, "show", `main:${FILE}`);
  const commits = () => Number(git(remote, "rev-list", "--count", "main").trim());
  return { g, text, commits, tools: new FakeTools().on("systemctl", () => okResult()) };
}

test("cli: score changes u and i", async () => {
  const w = setup();
  const before = w.commits();
  expect(await main([...w.g, "score", ID, "u=5", "i=4"], w.tools)).toBe(0);
  expect(out).toContain("u: 3 → 5, i: 3 → 4; priority 13");
  expect(w.commits()).toBe(before + 1);
  expect(w.text()).toBe(intentMd("web", "u: 5\ni: 4\n", "Thing"));
  // One score alone, and a drop under the cutoff says the intent is parked.
  out = "";
  expect(await main([...w.g, "score", ID, "u=1", "i=1"], w.tools)).toBe(0);
  expect(out).toContain("priority 3, parked");
});

test("commands: score applied without a loop", async () => {
  const w = setup();
  expect(await main([...w.g, "score", ID, "i=1"], w.tools)).toBe(0);
  expect(out).toContain(`${ID}: i: 3 → 1; priority 5, parked`);
  // Setting what it already has writes nothing.
  const n = w.commits();
  out = "";
  expect(await main([...w.g, "score", ID, "i=1"], w.tools)).toBe(0);
  expect(out).toContain("already has u 3, i 1");
  expect(w.commits()).toBe(n);
});

test("cli: score needs a value", async () => {
  const w = setup();
  expect(await main([...w.g, "score", ID], w.tools)).toBe(2);
  expect(err).toContain("score needs");
  expect(await main([...w.g, "score"], w.tools)).toBe(2);
});

test("cli: score refuses a bad value", async () => {
  const w = setup();
  const before = w.commits();
  expect(await main([...w.g, "score", ID, "u=9"], w.tools)).toBe(2);
  expect(err).toContain('bad score "u=9"');
  expect(await main([...w.g, "score", ID, "a=5"], w.tools)).toBe(2);
  expect(await main([...w.g, "score", ID, "u=2", "u=3"], w.tools)).toBe(2);
  expect(await main([...w.g, "score", "261107-9999", "u=2"], w.tools)).toBe(1);
  expect(w.commits()).toBe(before);
});

test("cli: score is refused on an a0 intent", async () => {
  const w = setup("u: 3\ni: 3\na: 0\n");
  const before = w.commits();
  expect(await main([...w.g, "score", ID, "u=5"], w.tools)).toBe(1);
  expect(err).toContain(`${ID} is only yours: use GitHub or the page`);
  expect(w.commits()).toBe(before);
});
