// Stay awake under WSL (LOOP-142): a powershell.exe child instead of systemd-inhibit.

import { expect, test } from "vitest";
import { Inhibitor, inhibitArgs } from "../src/awake.ts";
import { FakeTools } from "./helpers/tools.ts";

function held(t: FakeTools, cmd: string): () => void {
  let release: () => void = () => {};
  t.child(
    cmd,
    () =>
      new Promise((r) => {
        release = () => r({ code: 0, signal: null });
      }),
  );
  return () => release();
}

test("awake: wsl uses a powershell child with ES_SYSTEM_REQUIRED", () => {
  const t = new FakeTools();
  const release = held(t, "powershell.exe");
  const inh = new Inhibitor(t, () => {});
  inh.setWsl(true);
  inh.update("261026-1000 build", 0);
  expect(inh.running).toBe(true);
  const spec = t.spawned[0]!;
  expect(spec.kind).toBe("inhibit");
  expect(spec.argv.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 0x80000001 = 2147483649, set on the script's own thread.
  expect(spec.argv[4]).toContain("SetThreadExecutionState(2147483649)");
  expect(spec.argv[4]).toContain("kernel32.dll");
  inh.update("261026-1000 verify", 1000);
  expect(t.spawned.length).toBe(1);
  inh.stop();
  release();
});

test("awake: wsl child is killed when nothing is driven", () => {
  const t = new FakeTools();
  held(t, "powershell.exe");
  const inh = new Inhibitor(t, () => {});
  inh.setWsl(true);
  inh.update("261026-1000 build", 0);
  expect(inh.running).toBe(true);
  inh.update(null, 1000);
  expect(inh.running).toBe(false);
  expect(inh.why).toBeNull();
  // Driving again starts a new child.
  held(t, "powershell.exe");
  inh.update("261026-1001 build", 2000);
  expect(t.spawned.length).toBe(2);
  inh.stop();
});

test("awake: outside wsl keeps systemd-inhibit", () => {
  const t = new FakeTools();
  const release = held(t, "systemd-inhibit");
  const inh = new Inhibitor(t, () => {});
  inh.setWsl(false);
  inh.update("261026-1000 build", 0);
  expect(t.spawned[0]!.argv).toEqual(["systemd-inhibit", ...inhibitArgs("261026-1000 build")]);
  inh.stop();
  release();
});

test("awake: wsl without powershell runs unprotected", async () => {
  const t = new FakeTools();
  const log: string[] = [];
  const inh = new Inhibitor(t, (l) => log.push(l));
  inh.setWsl(true);
  inh.update("261026-1000 build", 0);
  // No powershell.exe child exists: it exits 127 at once.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  inh.update("261026-1000 build", 1000);
  expect(inh.running).toBe(false);
  expect(log).toEqual(["powershell.exe exited; retrying in 60 s"]);
  // Not retried before 60 s; the loop is not stopped by it.
  inh.update("261026-1000 build", 30_000);
  expect(t.spawned.length).toBe(1);
});
