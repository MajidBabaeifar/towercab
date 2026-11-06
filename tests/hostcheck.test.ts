// Ubuntu's restriction on user namespaces (PIP-162): Claude's own sandbox may use Unix sockets only while the
// restriction is on and Towercab's AppArmor profile for bwrap is not installed; doctor and the overview name
// the one owner step until it is.

import { expect, test } from "vitest";
import { type ClaudeRun, claudeSettings } from "../src/claude.ts";
import { doctor } from "../src/doctor.ts";
import {
  claudeUnixSockets,
  type HostReader,
  hostState,
  PROFILE_FILE,
  profileStep,
  RESTRICT_FILE,
} from "../src/pipeline/hostcheck.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

const host = (files: Record<string, string>): HostReader => ({ read: (p) => files[p] ?? null });
const PROFILE = "abi <abi/4.0>,\nprofile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n";

const RESTRICTED = host({ [RESTRICT_FILE]: "1\n" });
const WITH_PROFILE = host({ [RESTRICT_FILE]: "1\n", [PROFILE_FILE]: PROFILE });
const FREE = host({ [RESTRICT_FILE]: "0\n" });
const NO_APPARMOR = host({});

function settings(unixSockets: boolean) {
  const run = {
    kind: "worker",
    model: "opus",
    cwd: "/h/work/1",
    runsDir: "/h/runs/1",
    n: 1,
    prompt: "",
    session: { mode: "new", id: "u" },
    claudeMd: "",
    grants: { domains: ["registry.npmjs.org"], paths: [] },
    cacheEnv: {},
    unixSockets,
    config: testConfig({}, "/cfg/config.toml"),
  } as ClaudeRun;
  return claudeSettings(run, { towercabExe: "/t", home: "/home/me" }) as {
    sandbox: { network: Record<string, unknown> };
  };
}

test("hostcheck: restriction on and no profile turns the Claude setting on and shows the step", async () => {
  const s = hostState(RESTRICTED);
  expect(s).toEqual({ restricted: true, profile: false });
  expect(claudeUnixSockets(s)).toBe(true);
  expect(settings(claudeUnixSockets(s)).sandbox.network).toEqual({
    allowedDomains: ["registry.npmjs.org"],
    allowAllUnixSockets: true,
  });
  const step = profileStep(s, "/usr/bin/bwrap")!;
  expect(step.commands).toContain(`sudo tee ${PROFILE_FILE}`);
  expect(step.commands).toContain("profile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {");
  expect(step.commands).toContain(`sudo apparmor_parser -r ${PROFILE_FILE}`);
  // Doctor says it once, with the commands.
  const tools = new FakeTools().on("/usr/bin/bwrap", () => okResult("bubblewrap 0.9.0"));
  const r = await doctor({
    config: testConfig(),
    home: testHome(),
    tools,
    github: null,
    quick: false,
    probe: async () => ({ ok: true, why: "held" }),
    host: () => s,
  });
  expect(r.lines.filter((l) => l.startsWith("owner step: "))).toHaveLength(1);
  expect(r.lines.join("\n")).toContain(`  sudo apparmor_parser -r ${PROFILE_FILE}`);
});

test("hostcheck: the profile present turns the Claude setting off", async () => {
  const s = hostState(WITH_PROFILE);
  expect(s).toEqual({ restricted: true, profile: true });
  expect(claudeUnixSockets(s)).toBe(false);
  expect(settings(false).sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  expect(profileStep(s, "/usr/bin/bwrap")).toBeNull();
  const tools = new FakeTools().on("/usr/bin/bwrap", () => okResult("bubblewrap 0.9.0"));
  const r = await doctor({
    config: testConfig(),
    home: testHome(),
    tools,
    github: null,
    quick: false,
    probe: async () => ({ ok: true, why: "held" }),
    host: () => s,
  });
  expect(r.lines.some((l) => l.startsWith("owner step: "))).toBe(false);
});

test("hostcheck: no restriction leaves the Claude setting off", () => {
  for (const reader of [FREE, NO_APPARMOR]) {
    const s = hostState(reader);
    expect(s.restricted).toBe(false);
    expect(claudeUnixSockets(s)).toBe(false);
    expect(profileStep(s, "/usr/bin/bwrap")).toBeNull();
  }
  expect(JSON.stringify(settings(false))).not.toContain("allowAllUnixSockets");
});
