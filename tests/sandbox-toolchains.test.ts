// The sandbox binds the toolchains installed in their usual places (PIP-223..225): read-only, credential files
// masked, their `bin` directories on PATH, and the Go and Zig caches inside the sandbox cache.

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { cacheEnv, sandboxArgv, sandboxEnv, sandboxPath } from "../src/pipeline/sandbox.ts";
import {
  BWRAP_REQUIRED,
  bwrapUsable,
  escapeMode,
  inSandbox,
  type Plant,
  plant,
  SKIP_NOTE,
} from "./helpers/escape.ts";
import { tempDir } from "./helpers/world.ts";

const usable = bwrapUsable();
const mode = escapeMode(usable, BWRAP_REQUIRED);

function file(path: string, text = "", exec = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
}

/** Installs stub `cargo`, `go` and `zig` in the usual places of `home`. */
function install(home: string): void {
  file(join(home, ".cargo", "bin", "cargo"), "#!/bin/sh\necho cargo-ok\n", true);
  file(join(home, ".rustup", "settings.toml"), "");
  file(join(home, ".local", "go", "bin", "go"), "#!/bin/sh\necho go-ok\n", true);
  file(join(home, ".local", "zig-linux-x86_64-0.16.0", "zig"), "#!/bin/sh\necho zig-ok\n", true);
}

/** The `--ro-bind` pairs of an argv as `src->dst`. */
function roBinds(argv: string[]): string[] {
  return argv.flatMap((a, i) => (a === "--ro-bind" ? [`${argv[i + 1]}->${argv[i + 2]}`] : []));
}

function argvFor(home: string): string[] {
  return sandboxArgv({
    checkout: join(home, "..", "checkout"),
    home,
    cache: null,
    cacheWritable: false,
    line: "true",
  });
}

test("sandbox: a repo command finds cargo, go and zig installed in the usual places", (ctx) => {
  if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
  const home = tempDir();
  install(home);
  const path = sandboxPath(home).split(":");
  const zig = join(home, ".local", "zig-linux-x86_64-0.16.0");
  expect(path.indexOf(join(home, ".cargo", "bin"))).toBeLessThan(
    path.indexOf(join(home, ".local", "go", "bin")),
  );
  expect(path).toContain(zig);
  expect(path.indexOf("/usr/bin")).toBeGreaterThan(path.indexOf(zig));
  const binds = roBinds(argvFor(home));
  for (const d of [".cargo/bin", ".rustup", ".local/go", ".local/zig-linux-x86_64-0.16.0"]) {
    expect(binds).toContain(`${join(home, d)}->${join(home, d)}`);
  }
  if (mode === "skip") ctx.skip(SKIP_NOTE);
  // The real sandbox: under the repo, not /tmp, which the sandbox hides.
  const p = plant();
  try {
    install(p.home);
    const r = inSandbox(p, "cargo; go; zig");
    expect(r.out).toContain("cargo-ok");
    expect(r.out).toContain("go-ok");
    expect(r.out).toContain("zig-ok");
  } finally {
    p.cleanup();
  }
});

test("sandbox: a missing toolchain directory is skipped", () => {
  const home = tempDir();
  file(join(home, ".cargo", "bin", "cargo"), "", true);
  const binds = roBinds(argvFor(home)).join("\n");
  expect(binds).toContain(join(home, ".cargo", "bin"));
  for (const d of [".rustup", ".local/go", ".local/node", ".local/zig-"]) {
    expect(binds).not.toContain(join(home, d));
  }
  const path = sandboxPath(home);
  expect(path).toContain(join(home, ".cargo", "bin"));
  expect(path).not.toContain(".local/go");
  // A symlink that leaves HOME is skipped too.
  const outside = tempDir();
  mkdirSync(join(outside, "go", "bin"), { recursive: true });
  mkdirSync(join(home, ".local"), { recursive: true });
  symlinkSync(join(outside, "go"), join(home, ".local", "go"));
  expect(roBinds(argvFor(home)).join("\n")).not.toContain(join(home, ".local", "go"));
  expect(sandboxPath(home)).not.toContain(join(home, ".local", "go"));
});

test("sandbox: toolchain directories are read-only", (ctx) => {
  const home = tempDir();
  install(home);
  const argv = argvFor(home);
  for (const d of [".cargo/bin", ".rustup", ".local/go"]) {
    const i = argv.findIndex((a, k) => a === join(home, d) && argv[k - 1] === "--ro-bind");
    expect(i, d).toBeGreaterThan(0);
  }
  expect(argv.some((a, k) => a === "--bind" && argv[k + 1]?.startsWith(join(home, ".")))).toBe(false);
  if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
  if (mode === "skip") ctx.skip(SKIP_NOTE);
  const p = plant();
  try {
    install(p.home);
    const r = inSandbox(p, `echo x > ${join(p.home, ".cargo", "bin", "new")}`);
    expect(r.code).not.toBe(0);
  } finally {
    p.cleanup();
  }
});

// -- PIP-224 ----------------------------------------------------------------------------------------------

test("sandbox: a credentials file under a toolchain directory stays unreadable", () => {
  const home = tempDir();
  install(home);
  file(join(home, ".cargo", "bin", "credentials.toml"), "token");
  file(join(home, ".local", "go", ".netrc"), "machine x");
  file(join(home, ".local", "go", "pkg", "auth.json"), "{}");
  const binds = roBinds(argvFor(home));
  expect(binds).toContain(`/dev/null->${join(home, ".cargo", "bin", "credentials.toml")}`);
  expect(binds).toContain(`/dev/null->${join(home, ".local", "go", ".netrc")}`);
  expect(binds).toContain(`/dev/null->${join(home, ".local", "go", "pkg", "auth.json")}`);
  // A file that does not exist adds no argument.
  expect(binds.filter((b) => b.startsWith("/dev/null->")).length).toBe(3);
});

test("sandbox: the rest of ~/.cargo is not bound", () => {
  const home = tempDir();
  install(home);
  file(join(home, ".cargo", "credentials.toml"), "token");
  file(join(home, ".cargo", "config.toml"), "");
  const binds = roBinds(argvFor(home)).join("\n");
  expect(binds).toContain(`${join(home, ".cargo", "bin")}->`);
  expect(binds).not.toContain(`${join(home, ".cargo")}->`);
  expect(binds).not.toContain("credentials.toml");
});

test("sandbox escape: a toolchain credential file reads empty", (ctx) => {
  if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
  if (mode === "skip") ctx.skip(SKIP_NOTE);
  const p: Plant = plant();
  try {
    install(p.home);
    file(join(p.home, ".cargo", "bin", "credentials.toml"), "CARGO-CANARY");
    file(join(p.home, ".local", "go", ".netrc"), "GO-CANARY");
    const r = inSandbox(
      p,
      `cat ${join(p.home, ".cargo", "bin", "credentials.toml")} ${join(p.home, ".local", "go", ".netrc")}; ` +
        `cat ${join(p.home, ".cargo", "credentials.toml")}`,
    );
    expect(r.out).not.toContain("CARGO-CANARY");
    expect(r.out).not.toContain("GO-CANARY");
  } finally {
    p.cleanup();
  }
});

// -- PIP-225 ----------------------------------------------------------------------------------------------

/** A fresh HOME with the toolchains installed (the temp dir is removed after each test). */
function installed(): string {
  const h = tempDir();
  install(h);
  return h;
}

test("sandbox: go and zig caches are inside the sandbox cache", () => {
  const home = installed();
  const env = cacheEnv("/h/cache/web", null, home);
  for (const k of ["GOCACHE", "GOPATH", "GOMODCACHE", "ZIG_GLOBAL_CACHE_DIR", "ZIG_LOCAL_CACHE_DIR"]) {
    expect(env[k], k).toMatch(/^\/h\/cache\/web\//);
  }
  expect(env.GOMODCACHE).toContain("/go/");
  expect(env.ZIG_GLOBAL_CACHE_DIR).toContain("/zig/");
  expect(sandboxEnv(home, null, env).GOPATH).toBe(env.GOPATH);
});

test("sandbox: rustup home points at the bound toolchains", () => {
  const home = installed();
  expect(cacheEnv("/c", null, home).RUSTUP_HOME).toBe(join(home, ".rustup"));
  expect(cacheEnv("/c", null, tempDir()).RUSTUP_HOME).toBeUndefined();
});

test("sandbox: a repo variable cannot override a cache variable", () => {
  const repo = {
    env: { GOPATH: "/mine", GOMODCACHE: "/mine", ZIG_GLOBAL_CACHE_DIR: "/mine", RUSTUP_HOME: "/mine" },
  } as never;
  const home = installed();
  const env = cacheEnv("/c", repo, home);
  expect(env.GOPATH).toBe("/c/go/path");
  expect(env.GOMODCACHE).toBe("/c/go/path/pkg/mod");
  expect(env.ZIG_GLOBAL_CACHE_DIR).toBe("/c/zig/global");
  expect(env.RUSTUP_HOME).toBe(join(home, ".rustup"));
});
