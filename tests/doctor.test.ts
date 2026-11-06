// `towercab doctor` finds the owner's `gh` login in the text of `gh auth status` (LOOP-15).

import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import type { GitHub } from "../src/handlers.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

async function ghLoginLine(status: { stdout?: string; stderr?: string }): Promise<string> {
  const me = "owner";
  const github = {
    owner: async () => ({
      code: 0,
      stdout: status.stdout ?? "",
      stderr: status.stderr ?? "",
      timedOut: false,
    }),
  } as unknown as GitHub;
  const config = testConfig({ github: { app_id: 1, me } });
  const r = await doctor({ config, home: testHome(), tools: new FakeTools(), github, quick: false });
  const line = r.lines.find((l) => l.startsWith("gh login: "));
  expect(line).toBeDefined();
  return line as string;
}

test("doctor: gh login is found in the status text", async () => {
  expect(
    await ghLoginLine({ stdout: "github.com\n  ✓ Logged in to github.com account owner (keyring)\n" }),
  ).toBe("gh login: owner");
  // Older gh versions say "as", on stderr, and the case may differ from the config.
  expect(await ghLoginLine({ stderr: "✓ Logged in to github.com as Owner (oauth_token)\n" })).toBe(
    "gh login: owner",
  );
});

test("doctor: another gh login is not the owner's", async () => {
  const line = await ghLoginLine({ stdout: "✓ Logged in to github.com account owner2 (keyring)\n" });
  expect(line).toMatch(/^gh login: not logged in as owner /);
  expect(await ghLoginLine({ stdout: "You are not logged into any GitHub hosts.\n" })).toMatch(
    /^gh login: not logged in as owner /,
  );
});

test("doctor: shows the sandbox probe", async () => {
  const tools = new FakeTools().on("/usr/bin/bwrap", () => okResult("bubblewrap 0.9.0"));
  const config = testConfig();
  const held = await doctor({
    config,
    home: testHome(),
    tools,
    github: null,
    quick: false,
    probe: async () => ({ ok: true, why: "held" }),
  });
  expect(held.lines).toContain("bwrap version: bubblewrap 0.9.0");
  expect(held.lines).toContain("sandbox: the probe held");
  const failed = await doctor({
    config,
    home: testHome(),
    tools,
    github: null,
    quick: false,
    probe: async () => ({ ok: false, why: "the checkout's .git could be written" }),
  });
  expect(failed.ok).toBe(false);
  expect(failed.lines).toContain("sandbox: the probe failed: the checkout's .git could be written");
  // Not a namespace problem: no profile is suggested.
  expect(failed.lines.join("\n")).not.toContain("AppArmor");
});
