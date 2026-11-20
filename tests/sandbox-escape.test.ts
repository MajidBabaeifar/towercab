// Escape attempts against the real sandbox (PIP-160, PIP-159): each one runs through the production builder
// and must fail. Without a usable bwrap each is skipped with `skipped: no bwrap`; GitHub Actions installs bwrap
// and the AppArmor profile (PIP-162), so there a missing bwrap fails instead.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, type TestContext, test } from "vitest";
import {
  BWRAP_REQUIRED,
  bwrapUsable,
  escapeMode,
  inSandbox,
  type Plant,
  plant,
  SKIP_NOTE,
} from "./helpers/escape.ts";

const usable = bwrapUsable();
let p: Plant;

beforeAll(() => {
  p = plant();
});
afterAll(() => p.cleanup());

/** The test body: runs `body` in the real sandbox, or skips with the note, or fails where CI must have bwrap. */
function attempt(body: () => void): (ctx: TestContext) => void {
  return (ctx) => {
    const mode = escapeMode(usable, BWRAP_REQUIRED);
    if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
    if (mode === "skip") ctx.skip(SKIP_NOTE);
    body();
  };
}

const CANARIES = ["SSH-CANARY", "GH-CANARY", "CLAUDE-CANARY", "APP-KEY-CANARY"];

test(
  "sandbox escape: ssh keys cannot be read",
  attempt(() => {
    // Control: the file is there for anyone outside the sandbox.
    expect(readFileSync(join(p.home, ".ssh", "id_ed25519"), "utf8")).toBe("SSH-CANARY");
    const r = inSandbox(p, `cat "${join(p.home, ".ssh", "id_ed25519")}" "$HOME/.ssh/id_ed25519"`);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("SSH-CANARY");
  }),
);

test(
  "sandbox escape: the app key cannot be read",
  attempt(() => {
    const r = inSandbox(p, `cat "${join(p.home, ".config", "towercab", "app.pem")}"`);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("APP-KEY-CANARY");
  }),
);

test(
  "sandbox escape: a write outside the checkout fails",
  attempt(() => {
    const r = inSandbox(p, `echo x > "${p.outside}"; echo x > /etc/tc-escape; echo x > "${p.base}/new.txt"`);
    expect(r.code).not.toBe(0);
    expect(readFileSync(p.outside, "utf8")).toBe("outside");
    expect(existsSync(join(p.base, "new.txt"))).toBe(false);
  }),
);

test(
  "sandbox escape: a write into .git fails",
  attempt(() => {
    const r = inSandbox(p, `echo x > .git/hooks/pre-commit; echo x > .git/config`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(p.checkout, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(p.checkout, ".git", "config"))).toBe(false);
    // The checkout itself is writable.
    expect(inSandbox(p, "echo ok > fine.txt").code).toBe(0);
  }),
);

test(
  "sandbox escape: the network is unreachable without a grant",
  attempt(() => {
    // Only the loopback exists, and a direct connection by IP has no route.
    const r = inSandbox(
      p,
      `[ "$(tail -n +3 /proc/net/dev | wc -l)" = 1 ] || exit 3; curl -sS -m 5 http://1.1.1.1/ || exit 4`,
    );
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(3);
  }),
);

test(
  "sandbox escape: secret variables are not set",
  attempt(() => {
    const r = inSandbox(p, "env");
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|ANTHROPIC|SSH_AUTH_SOCK|AWS_|SOPS_|AGE_/);
  }),
);

test(
  "sandbox escape: host processes are not visible",
  attempt(() => {
    const r = inSandbox(p, `[ -d /proc/${process.pid} ] && exit 5; ls /proc | grep -c '^[0-9]'`);
    expect(r.code).toBe(0);
    expect(Number(r.out.trim().split("\n").at(-1))).toBeLessThan(10);
  }),
);

test(
  "sandbox: ssh keys and the app key are unreadable",
  attempt(() => {
    const r = inSandbox(p, "cat ~/.ssh/* ~/.config/towercab/* 2>&1; ls -A ~");
    expect(CANARIES.some((c) => r.out.includes(c))).toBe(false);
  }),
);

test(
  "sandbox: gh and claude credentials are unreadable",
  attempt(() => {
    const r = inSandbox(p, "cat ~/.config/gh/hosts.yml ~/.claude/.credentials.json 2>&1; ls -A ~");
    expect(r.out).not.toContain("GH-CANARY");
    expect(r.out).not.toContain("CLAUDE-CANARY");
  }),
);

test(
  "sandbox: a repo command sees no credential variable",
  attempt(() => {
    const r = inSandbox(p, "env | cut -d= -f1 | sort | tr '\\n' ' '");
    expect(r.out).not.toMatch(/TOKEN|SECRET|PASSWORD|SSH_AUTH_SOCK|ANTHROPIC|AWS_/);
  }),
);

test("sandbox escape: without bwrap the attempts are skipped with a note", () => {
  expect(escapeMode(false, false)).toBe("skip");
  expect(SKIP_NOTE).toBe("skipped: no bwrap");
  expect(escapeMode(true, false)).toBe("run");
});

test("sandbox escape: CI installs bwrap and fails when it is missing", () => {
  expect(escapeMode(false, true)).toBe("fail");
  expect(escapeMode(true, true)).toBe("run");
  // The workflow installs bwrap and the AppArmor profile before the checks run.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(ci).toContain("bubblewrap");
  expect(ci).toContain("apparmor_parser");
  if (BWRAP_REQUIRED) expect(usable, "bwrap must work in CI").toBe(true);
});
