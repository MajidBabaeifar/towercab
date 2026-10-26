import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Inhibitor, inhibitArgs, woke } from "../src/awake.ts";
import { down, logsArgv, restart, unitPath, unitText, up } from "../src/service.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { tempDir } from "./helpers/world.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir();
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
});

test("service: unit file", () => {
  const text = unitText("/home/o/towercab", "/home/o/.local/node/bin");
  expect(text).toContain("ExecStart=/home/o/towercab/bin/towercab run --watch\n");
  expect(text).toContain(
    "Environment=PATH=/home/o/.local/node/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n",
  );
  expect(text).toContain("Restart=always\n");
  expect(text).toContain("KillMode=mixed\n");
  const spec = readFileSync("specs/loop.md", "utf8");
  const block = spec.slice(spec.indexOf("**Unit**")).split("```ini\n")[1]!.split("```")[0]!;
  expect(text).toBe(
    block.replace("<checkout>", "/home/o/towercab").replace("<node dir>", "/home/o/.local/node/bin"),
  );
});

test("service: up, down, restart, logs", async () => {
  const t = new FakeTools().on("systemctl", () => okResult());
  expect(await up(t, "/c", "/n")).toMatch(/running from \/c/);
  expect(readFileSync(unitPath(), "utf8")).toContain("ExecStart=/c/bin/towercab run --watch");
  expect(unitPath()).toBe(join(process.env.XDG_CONFIG_HOME!, "systemd/user/towercab.service"));
  await down(t);
  await restart(t);
  expect(t.lines("systemctl")).toEqual([
    "--user daemon-reload",
    "--user enable --now towercab.service",
    "--user disable --now towercab.service",
    "--user restart towercab.service",
  ]);
  expect(logsArgv()).toEqual(["journalctl", "--user", "-u", "towercab", "-f"]);
  const bad = new FakeTools().on("systemctl", () => failResult("Failed to connect to bus"));
  await expect(down(bad)).rejects.toThrow(/Failed to connect to bus/);
});

test("awake: inhibit while driving", async () => {
  const t = new FakeTools();
  let release: () => void = () => {};
  t.child(
    "systemd-inhibit",
    () =>
      new Promise((r) => {
        release = () => r({ code: 0, signal: null });
      }),
  );
  const inh = new Inhibitor(t, () => {});
  inh.update("261026-1000 build", 0);
  expect(inh.running).toBe(true);
  expect(t.spawned[0]!.argv).toEqual(["systemd-inhibit", ...inhibitArgs("261026-1000 build")]);
  inh.update("261026-1000 verify", 1000);
  expect(t.spawned.length).toBe(1);
  inh.update(null, 2000);
  expect(inh.running).toBe(false);
  release();
});

test("awake: wake re-polls before timeouts", () => {
  expect(woke({ wall: 1000, mono: 0 }, { wall: 1005, mono: 5000 }, 5)).toBe(false);
  expect(woke({ wall: 1000, mono: 0 }, { wall: 4600, mono: 5000 }, 5)).toBe(true);
});
