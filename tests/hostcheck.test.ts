// Ubuntu's restriction on user namespaces (PIP-162): the probe decides. A sandbox that works never gets the card,
// whatever files exist; one that fails shows the profile install command when the restriction is on without the
// profile, and the probe's own error otherwise. While it fails, nothing is picked and no Claude run starts.

import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import {
  checkSandbox,
  type HostReader,
  hostState,
  needsProfile,
  PROFILE_FILE,
  profileStep,
  RESTRICT_FILE,
  sandboxFailure,
} from "../src/pipeline/hostcheck.ts";
import { happy, intent, intents, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { testConfig, testHome } from "./helpers/world.ts";

const host = (files: Record<string, string>): HostReader => ({ read: (p) => files[p] ?? null });
const PROFILE = "abi <abi/4.0>,\nprofile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n";
const RESTRICTED = host({ [RESTRICT_FILE]: "1\n" });
const WITH_PROFILE = host({ [RESTRICT_FILE]: "1\n", [PROFILE_FILE]: PROFILE });
const FREE = host({ [RESTRICT_FILE]: "0\n" });

const sound = () => new FakeTools().on("/usr/bin/bwrap", () => okResult("held\n"));
const broken = (why = "bwrap: setting up uid map: Permission denied") =>
  new FakeTools().on("/usr/bin/bwrap", () => failResult(why, 1));

/** A mission started with the loop probing through `checkSandbox`: what ran, and what the owner was told. */
async function run(tools: FakeTools, reader: HostReader) {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    const loop = await p.start();
    Object.assign(loop.d, { sandboxProbe: () => checkSandbox(tools, reader) });
    await loop.pass();
    await loop.pass();
    await p.until(() => p.claudeCalls.length > 0 || loop.health.open().length > 0);
    return {
      mission: p.mission(),
      faults: loop.health.open().map((f) => f.error),
      calls: p.claudeCalls.length,
    };
  } finally {
    p.cleanup();
  }
}

test("hostcheck: a working sandbox runs with the restriction on and no profile file", async () => {
  expect(needsProfile(hostState(RESTRICTED))).toBe(true);
  // The probe passes, so no card whatever files exist.
  expect(await checkSandbox(sound(), RESTRICTED)).toEqual({ ok: true, why: "held" });
  const got = await run(sound(), RESTRICTED);
  expect(got.faults).toEqual([]);
  expect(got.mission).toBeDefined();
  expect(got.calls).toBeGreaterThan(0);
  // Doctor shows no owner step either.
  const r = await doctor({
    config: testConfig(),
    home: testHome(),
    tools: new FakeTools().on("/usr/bin/bwrap", () => okResult("bubblewrap 0.9.0")),
    github: null,
    quick: false,
    probe: async () => ({ ok: true, why: "held" }),
    host: () => hostState(RESTRICTED),
  });
  expect(r.lines.some((l) => l.startsWith("owner step: "))).toBe(false);
});

test("hostcheck: a failed probe with the restriction on and no profile shows the install command", async () => {
  const s = hostState(RESTRICTED);
  const step = profileStep(s, "/usr/bin/bwrap")!;
  expect(step.commands).toContain(`sudo tee ${PROFILE_FILE}`);
  expect(step.commands).toContain("profile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {");
  expect(step.commands).toContain(`sudo apparmor_parser -r ${PROFILE_FILE}`);
  const r = await checkSandbox(broken(), RESTRICTED);
  expect(r.ok).toBe(false);
  expect(r.why).toContain("setting up uid map");
  expect(r.why).toContain(`| sudo tee ${PROFILE_FILE} >/dev/null && sudo apparmor_parser -r ${PROFILE_FILE}`);
  // Nothing is picked, no Claude run starts, and the owner sees the command.
  const got = await run(broken(), RESTRICTED);
  expect(got.mission).toBeUndefined();
  expect(got.calls).toBe(0);
  expect(got.faults).toHaveLength(1);
  expect(got.faults[0]).toContain("sudo apparmor_parser -r");
  // Doctor says the step once, with the commands.
  const d = await doctor({
    config: testConfig(),
    home: testHome(),
    tools: broken(),
    github: null,
    quick: false,
    host: () => s,
  });
  expect(d.lines.filter((l) => l.startsWith("owner step: "))).toHaveLength(1);
  expect(d.lines.join("\n")).toContain(`  sudo apparmor_parser -r ${PROFILE_FILE}`);
});

test("hostcheck: a failed probe otherwise shows the probe's error", async () => {
  for (const reader of [FREE, WITH_PROFILE, host({})]) {
    const r = await checkSandbox(broken("bwrap: execvp sh: No such file"), reader);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("execvp sh: No such file");
    expect(r.why).not.toContain("apparmor_parser");
    expect(sandboxFailure({ ok: false, why: "boom" }, hostState(reader), "/usr/bin/bwrap")).toBe("boom");
  }
  const got = await run(broken("bwrap: execvp sh: No such file"), FREE);
  expect(got.mission).toBeUndefined();
  expect(got.calls).toBe(0);
  expect(got.faults[0]).toContain("execvp sh: No such file");
  expect(got.faults[0]).not.toContain("apparmor_parser");
});
