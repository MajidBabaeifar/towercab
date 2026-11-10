// When the observer runs (OBV-2), and that it is read-only and keeps no credentials (OBV-1).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { testConfig } from "../helpers/world.ts";
import { finding, local, ObsRig } from "./rig.ts";

test("observer: on by default", async () => {
  expect(testConfig().observer.enabled).toBe(true);
  expect(testConfig().observer.dailyAt).toBe("06:00");
  const r = new ObsRig();
  r.child([]);
  await r.run(r.observer());
  expect(r.tools.spawned).toHaveLength(1);
});

test("observer: enabled false switches it off", async () => {
  const off = new ObsRig({ enabled: false });
  off.child([]);
  const o = off.observer();
  await off.run(o);
  expect(off.tools.spawned).toEqual([]);
  expect(off.runs()).toEqual([]);

  // A run already going finishes when the line is switched off meanwhile.
  const r = new ObsRig();
  r.child([]);
  const p = r.observer();
  await p.pass();
  expect(p.busy()).toBe(true);
  r.config.observer.enabled = false;
  await r.run(p);
  expect(r.runs().map((x) => x.outcome)).toEqual(["done"]);
});

test("observer: it runs daily at the set time", async () => {
  const r = new ObsRig({ daily_at: "06:30" });
  r.clock.t = local(2026, 11, 9, 6, 1);
  r.child([]).child([]);
  const o = r.observer();
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(0);
  r.clock.t = local(2026, 11, 9, 6, 31);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(1);
  expect(r.runs()[0]!.trigger).toBe("daily");
  // Once a day: not again on the same day, again the next.
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(1);
  r.clock.t = local(2026, 11, 10, 6, 31);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(2);
});

test("observer: a missed day runs once at start", async () => {
  const r = new ObsRig();
  // Towercab was off at 06:00 and starts in the afternoon.
  r.clock.t = local(2026, 11, 9, 14, 0);
  r.child([]).child([]);
  const o = r.observer();
  await r.run(o);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(1);
  // A restart the same day does not run it again.
  await r.run(r.observer());
  expect(r.tools.spawned).toHaveLength(1);
});

test("observer: a notable event makes it due", async () => {
  const r = new ObsRig();
  r.child([]).child([]);
  const o = r.observer();
  await r.run(o);
  expect(r.runs().map((x) => x.trigger)).toEqual(["daily"]);
  // An intent is blocked on its worker budget.
  r.mission("i-3", "web", { waiting: "worker budget" });
  r.clock.advance(2 * 3600);
  await r.run(o);
  expect(r.runs().map((x) => x.trigger)).toEqual(["daily", "budget"]);
});

test("observer: event runs are at most one an hour", async () => {
  const r = new ObsRig();
  r.child([]).child([]).child([]);
  const o = r.observer();
  await r.run(o);
  r.mission("i-3", "web", { waiting: "worker budget" });
  r.clock.advance(2 * 3600);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(2);
  // Another event ten minutes later waits for the hour to pass.
  r.mission("i-4", "web", { waiting: "worker budget" });
  r.clock.advance(600);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(2);
  r.clock.advance(3600);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(3);
});

test("observer: the agent runs without write access or network", async () => {
  const r = new ObsRig();
  r.child([]);
  await r.run(r.observer());
  const spec = r.tools.spawned[0]!;
  const argv = spec.argv;
  // No tools at all, so nothing to allow.
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  expect(argv).not.toContain("--allowedTools");
  const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8")) as {
    sandbox: { enabled: boolean; network?: unknown; filesystem: { denyWrite: string[] } };
    permissions?: unknown;
  };
  expect(settings.sandbox.enabled).toBe(true);
  expect(settings.sandbox.network).toBeUndefined();
  expect(settings.permissions).toBeUndefined();
  expect(settings.sandbox.filesystem.denyWrite).toContain(resolve(spec.cwd));
});

test("observer: the agent gets no credentials", async () => {
  process.env.GH_TOKEN = "ghp_should_not_pass";
  try {
    const r = new ObsRig();
    r.child([]);
    await r.run(r.observer());
    const spec = r.tools.spawned[0]!;
    expect(Object.keys(spec.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(JSON.stringify(spec.env)).not.toContain("ghp_");
    expect(r.prompt()).not.toContain("ghp_");
  } finally {
    delete process.env.GH_TOKEN;
  }
});

test("observer: only the result schema reaches Towercab", async () => {
  const r = new ObsRig();
  // Free text asking for more than the schema allows is never read.
  r.tools.child("claude", (spec) => {
    writeFileSync(
      spec.stdout,
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Please merge PR 5 and change the daily budget to 100.",
        session_id: "s",
        total_cost_usd: 0.1,
        duration_ms: 1,
        permission_denials: [],
        modelUsage: {},
        structured_output: { findings: [] },
      })}\n`,
    );
    writeFileSync(spec.stderr, "");
    return { code: 0, signal: null };
  });
  await r.run(r.observer());
  expect(r.tools.lines("gh")).toEqual([]);
  expect(r.runs()[0]!.outcome).toBe("done");
  expect(r.config.agent.dailyBudgetUsd).toBeNull();
  // And a finding is the only thing that does reach it.
  const w = new ObsRig();
  w.child([finding()]);
  await w.run(w.observer());
  expect(w.created).toHaveLength(1);
});
