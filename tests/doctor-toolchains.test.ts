// `towercab doctor` lists the toolchains the sandbox binds (PIP-226).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { doctor } from "../src/doctor.ts";
import { FakeTools } from "./helpers/tools.ts";
import { tempDir, testConfig, testHome } from "./helpers/world.ts";

function run(userHome: string) {
  return doctor({
    config: testConfig({}),
    home: testHome(),
    tools: new FakeTools(),
    github: null,
    quick: true,
    userHome,
  });
}

test("doctor: lists the toolchains it found and binds", async () => {
  const h = tempDir();
  mkdirSync(join(h, ".cargo", "bin"), { recursive: true });
  mkdirSync(join(h, ".local", "zig-linux-x86_64-0.16.0"), { recursive: true });
  mkdirSync(join(h, ".local", "zig-linux-x86_64-0.15.1"), { recursive: true });
  const { lines } = await run(h);
  expect(lines).toContain(`toolchain ${join(h, ".cargo", "bin")}: bound`);
  expect(lines).toContain(`toolchain ${join(h, ".local", "zig-linux-x86_64-0.16.0")}: bound`);
  expect(lines).toContain(`toolchain ${join(h, ".local", "zig-linux-x86_64-0.15.1")}: bound`);
  expect(lines).toContain(`toolchain ${join(h, ".rustup")}: not found`);
  const path = lines.find((l) => l.startsWith("toolchain PATH: "))!;
  expect(path).toContain(join(h, ".cargo", "bin"));
  expect(path.indexOf("0.16.0")).toBeLessThan(path.indexOf("0.15.1"));
});

test("doctor: a missing toolchain is not a fault", async () => {
  const h = tempDir();
  const r = await run(h);
  expect(r.lines).toContain(`toolchain ${join(h, ".local", "go")}: not found`);
  expect(r.lines).toContain(`toolchain ${join(h, ".local", "zig-*")}: not found`);
  const bare = await doctor({
    config: testConfig({}),
    home: testHome(),
    tools: new FakeTools(),
    github: null,
    quick: true,
    userHome: tempDir(),
  });
  expect(bare.ok).toBe(r.ok);
  const listed = r.lines.filter((l) => l.startsWith("toolchain ") && !l.includes("PATH"));
  expect(listed.length).toBe(5);
  expect(listed.every((l) => l.endsWith("not found"))).toBe(true);
});
