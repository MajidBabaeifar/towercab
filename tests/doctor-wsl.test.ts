// `towercab doctor` under WSL and its secrets-file check (LOOP-143, LOOP-145).

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { Home } from "../src/home.ts";
import { hasVmIdleTimeout } from "../src/wsl.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { tempDir, testConfig, testHome } from "./helpers/world.ts";

const RELEASE = "5.15.153.1-microsoft-standard-WSL2";

interface Opts {
  wsl?: boolean;
  pid1?: string;
  powershell?: boolean;
  wslconfig?: string | null;
  mode?: number;
  home?: Home;
  quick?: boolean;
  forUpdate?: boolean;
  probe?: { ok: boolean; why: string };
}

async function run(o: Opts = {}) {
  const dir = tempDir("tc-doctor-");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  writeFileSync(file, "");
  writeFileSync(join(dir, "app.pem"), "key");
  chmodSync(join(dir, "app.pem"), o.mode ?? 0o600);
  const tools = new FakeTools().on("cat", (args) =>
    args[0] === "/proc/sys/kernel/osrelease"
      ? o.wsl === false
        ? okResult("6.8.0-generic\n")
        : okResult(`${RELEASE}\n`)
      : okResult(`${o.pid1 ?? "systemd"}\n`),
  );
  if (o.powershell !== false) tools.present.add("powershell.exe");
  tools.on("powershell.exe", () =>
    o.wslconfig === null ? failResult("denied") : okResult(o.wslconfig ?? "[wsl2]\nvmIdleTimeout=-1\n"),
  );
  const r = await doctor({
    config: testConfig({}, file),
    home: o.home ?? testHome(),
    tools,
    github: null,
    quick: o.quick ?? true,
    forUpdate: o.forUpdate,
    probe: async () => o.probe ?? { ok: true, why: "held" },
    host: () => ({ restricted: false, profile: false, stock: false }),
  });
  return { ...r, dir };
}

test("doctor: wsl prints the kernel release", async () => {
  const r = await run();
  expect(r.lines).toContain(`wsl: ${RELEASE}`);
  expect(r.ok).toBe(true);
  expect(r.lines.filter((l) => l.startsWith("warning:"))).toEqual([]);
});

test("doctor: wsl without systemd as pid 1 fails", async () => {
  const r = await run({ pid1: "init" });
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toMatch(
    /systemd is not PID 1: enable it with \[boot\] systemd=true in \/etc\/wsl\.conf, then run wsl --shutdown/,
  );
});

test("doctor: wsl failed sandbox probe fails", async () => {
  const r = await run({
    quick: false,
    probe: { ok: false, why: "bwrap: setting up uid map: Permission denied" },
  });
  expect(r.ok).toBe(false);
  expect(r.lines.join("\n")).toMatch(
    /sandbox: the probe failed: bwrap: setting up uid map: Permission denied/,
  );
});

test("doctor: wsl paths under /mnt fail", async () => {
  const r = await run({ home: new Home("/mnt/c/Users/me/towercab") });
  expect(r.ok).toBe(false);
  const text = r.lines.join("\n");
  expect(text).toMatch(
    /wsl: home \/mnt\/c\/Users\/me\/towercab is under \/mnt\/: keep it in the Linux file system/,
  );
  expect(text).toMatch(/wsl: web \/mnt\/c\/Users\/me\/towercab\/repos\/web is under \/mnt\//);
  expect((await run()).lines.join("\n")).not.toMatch(/under \/mnt\//);
});

test("doctor: a secrets file not mode 600 fails with the chmod", async () => {
  const r = await run({ mode: 0o644 });
  const key = join(r.dir, "app.pem");
  expect(r.ok).toBe(false);
  expect(r.lines).toContain(`secrets: ${key} is readable by others: chmod 600 ${key}`);
});

test("doctor: a loose secrets file fails outside wsl", async () => {
  const r = await run({ wsl: false, mode: 0o640 });
  const key = join(r.dir, "app.pem");
  expect(r.ok).toBe(false);
  expect(r.lines).toContain(`secrets: ${key} is readable by others: chmod 600 ${key}`);
});

test("doctor: a loose secrets file fails without the flag", async () => {
  const r = await run({ wsl: false, mode: 0o644, quick: true, forUpdate: false });
  expect(r.ok).toBe(false);
});

test("doctor: --for-update turns a loose secrets file into a warning", async () => {
  const r = await run({ wsl: false, mode: 0o644, forUpdate: true });
  const key = join(r.dir, "app.pem");
  expect(r.ok).toBe(true);
  expect(r.lines).toContain(`warning: ${key} is readable by others: chmod 600 ${key}`);
});

test("doctor: wsl without powershell warns", async () => {
  const r = await run({ powershell: false });
  expect(r.ok).toBe(true);
  expect(r.lines.join("\n")).toMatch(
    /warning: wsl: powershell\.exe is not on PATH, so Windows may sleep while missions run/,
  );
});

test("doctor: wsl without vmIdleTimeout warns", async () => {
  for (const wslconfig of ["", "[wsl2]\nmemory=8GB\n", "[experimental]\nvmIdleTimeout=-1\n"]) {
    const r = await run({ wslconfig });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(
      /warning: wsl: no keep-alive.*set vmIdleTimeout=-1 under \[wsl2\] in %UserProfile%\\\.wslconfig, then run wsl --shutdown/,
    );
  }
  const unreadable = await run({ wslconfig: null });
  expect(unreadable.ok).toBe(true);
  expect(unreadable.lines.join("\n")).toMatch(
    /warning: wsl: \.wslconfig could not be read.*vmIdleTimeout=-1/,
  );
});

test("doctor: wsl with vmIdleTimeout is quiet", async () => {
  const r = await run({ wslconfig: "# note\n[wsl2]\nmemory=8GB\nvmIdleTimeout = -1\n" });
  expect(r.lines.join("\n")).not.toMatch(/keep-alive|\.wslconfig/);
  expect(hasVmIdleTimeout("[wsl2]\r\nvmIdleTimeout=60000\r\n")).toBe(true);
  expect(hasVmIdleTimeout("[wsl2]\n# vmIdleTimeout=1\n")).toBe(false);
});

test("doctor: outside wsl prints no wsl lines", async () => {
  const r = await run({ wsl: false });
  expect(r.lines.filter((l) => /wsl|warning:/i.test(l))).toEqual([]);
  expect(r.ok).toBe(true);
});
