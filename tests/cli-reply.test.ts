// `towercab reply <id> --by <agent> <text>` (PIP-184): an agent speaks for the owner, marked as the agent's.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { authStatus } from "./github/fakes.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

const ID = "261106-0002";
const ISSUE = "https://github.com/owner/web/issues/5";

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

/** A home whose intents repo holds one intent (`extra` front matter) that came from issue 5. */
function world(extra = "", github = '[github]\napp_id = 1\nme = "owner"\nname = "Majid"\n') {
  const intents = bareRepo({
    "intents/.keep": "",
    [`intents/${ID}-t/intent.md`]: intentMd("web", `u: 4\ni: 5\n${extra}issue: ${ISSUE}\n`, "T"),
  });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(config, `[intents]\nremote = "${intents}"\n\n${github}\n[repos.web]\ngithub = "owner/web"\n`);
  const tools = new FakeTools().on("gh", (args) =>
    args[0] === "auth" ? okResult(authStatus("owner")) : okResult(""),
  );
  return { g: ["--config", config, "--home", join(dir, "home")], tools };
}

const comment = (t: FakeTools) => t.calls.find((c) => c.args[0] === "issue" && c.args[1] === "comment");

test("cli: reply --by writes the first line and marker", async () => {
  const { g, tools } = world();
  expect(await main([...g, "reply", ID, "--by", "claude-code", "Use", "the", "other", "table."], tools)).toBe(
    0,
  );
  const c = comment(tools)!;
  expect(c.args.slice(0, 4)).toEqual(["issue", "comment", "5", "-R"]);
  expect(c.args[4]).toBe("owner/web");
  // The owner's login, never the App's.
  expect(c.opts.env?.GH_TOKEN).toBeUndefined();
  const lines = c.opts.input!.split("\n");
  expect(lines[0]).toBe("<!-- towercab:agent:claude-code -->");
  expect(lines[1]).toBe("🤖 claude-code (for Majid)");
  expect(lines[2]).toBe("");
  expect(lines[3]).toBe("Use the other table.");
  expect(out).toContain("posted on owner/web#5 as claude-code");
});

test("cli: reply names the owner by login when no name is set", async () => {
  const { g, tools } = world("", '[github]\napp_id = 1\nme = "owner"\n');
  expect(await main([...g, "reply", ID, "--by", "shadow", "ok"], tools)).toBe(0);
  expect(comment(tools)!.opts.input!.split("\n")[1]).toBe("🤖 shadow (for owner)");
});

test("cli: reply refuses a missing or invalid agent name", async () => {
  const { g, tools } = world();
  expect(await main([...g, "reply", ID, "hello"], tools)).toBe(2);
  expect(err).toContain("reply needs --by <agent>");
  for (const by of ["", "has space", "x".repeat(33), "bad/name", "a>b"]) {
    err = "";
    expect(await main([...g, "reply", ID, "--by", by, "hello"], tools), by).toBe(1);
    expect(err).toContain("--by");
  }
  expect(await main([...g, "reply", ID, "--by", "claude-code", "  "], tools)).toBe(1);
  expect(await main([...g, "reply", "261106-9999", "--by", "claude-code", "hi"], tools)).toBe(1);
  // Nothing was posted.
  expect(comment(tools)).toBeUndefined();
});

test("cli: reply works on an a0 intent", async () => {
  const { g, tools } = world("a: 0\n");
  expect(await main([...g, "reply", ID, "--by", "claude-code", "A hint."], tools)).toBe(0);
  expect(comment(tools)!.opts.input).toContain("<!-- towercab:agent:claude-code -->");
});
