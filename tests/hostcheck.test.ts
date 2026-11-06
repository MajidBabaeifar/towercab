// Ubuntu's restriction on user namespaces (PIP-162): while it is on and Towercab's AppArmor profile for bwrap is
// not installed, no Claude run starts and the owner gets one step; nothing is ever loosened to make it work.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import {
  type HostReader,
  type HostState,
  hostState,
  needsProfile,
  PROFILE_FILE,
  profileStep,
  RESTRICT_FILE,
} from "../src/pipeline/hostcheck.ts";
import { happy, intent, intents, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

const host = (files: Record<string, string>): HostReader => ({ read: (p) => files[p] ?? null });
const PROFILE = "abi <abi/4.0>,\nprofile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n";

const RESTRICTED = host({ [RESTRICT_FILE]: "1\n" });
const WITH_PROFILE = host({ [RESTRICT_FILE]: "1\n", [PROFILE_FILE]: PROFILE });
const FREE = host({ [RESTRICT_FILE]: "0\n" });
const NO_APPARMOR = host({});

const runWith = async (state: HostState) => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    const loop = await p.start();
    Object.assign(loop.d, { hostState: () => state });
    await p.until(() => p.mission()?.stage === "blocked" || p.claudeCalls.length > 0);
    const m = p.mission()!;
    return { stage: m.stage, waiting: m.waiting, why: m.why, calls: p.claudeCalls.length };
  } finally {
    p.cleanup();
  }
};

test("hostcheck: restriction on and no profile starts no run and shows the step", async () => {
  const s = hostState(RESTRICTED);
  expect(s).toEqual({ restricted: true, profile: false });
  expect(needsProfile(s)).toBe(true);
  const step = profileStep(s, "/usr/bin/bwrap")!;
  expect(step.commands).toContain(`sudo tee ${PROFILE_FILE}`);
  expect(step.commands).toContain("profile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {");
  expect(step.commands).toContain(`sudo apparmor_parser -r ${PROFILE_FILE}`);
  expect(step.oneLine).toContain(
    `| sudo tee ${PROFILE_FILE} >/dev/null && sudo apparmor_parser -r ${PROFILE_FILE}`,
  );
  // The loosening is gone: no Claude setting allows every Unix socket, whatever the host says.
  expect(readFileSync("src/claude.ts", "utf8")).not.toContain("allowAllUnixSockets = true");
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
  // The mission waits with the card and no Claude run started.
  const got = await runWith(s);
  expect([got.stage, got.waiting, got.calls]).toEqual(["blocked", "install sandbox profile", 0]);
  expect(got.why).toContain("Allow Towercab's sandbox on this machine. Run: printf ");
});

test("hostcheck: the profile present lets runs start", async () => {
  const s = hostState(WITH_PROFILE);
  expect(s).toEqual({ restricted: true, profile: true });
  expect(needsProfile(s)).toBe(false);
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
  const got = await runWith(s);
  expect(got.calls).toBeGreaterThan(0);
  expect(got.waiting).not.toBe("install sandbox profile");
});

test("hostcheck: no restriction needs no profile", () => {
  for (const reader of [FREE, NO_APPARMOR]) {
    const s = hostState(reader);
    expect(s.restricted).toBe(false);
    expect(needsProfile(s)).toBe(false);
    expect(profileStep(s, "/usr/bin/bwrap")).toBeNull();
  }
});
