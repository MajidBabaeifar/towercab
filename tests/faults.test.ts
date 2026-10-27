// Network, auth and tool failures (LOOP-10): classified, health per kind, one message after 15 minutes.

import { expect, test } from "vitest";
import { classifyFailure, classifyRun, fixFor, Health } from "../src/faults.ts";
import { envBackoff } from "../src/machine.ts";

const DNS = "fatal: unable to access 'https://github.com/me/web.git/': Could not resolve host: github.com";

test("faults: classify", () => {
  const cases: [string, "network" | "auth" | null][] = [
    [DNS, "network"],
    ["ssh: connect to host github.com port 22: Connection refused", "network"],
    ["error: RPC failed; curl 56 Recv failure: Connection reset by peer", "network"],
    ["Failed to connect to github.com port 443 after 130000 ms: Timed out", "network"],
    [
      "fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server",
      "network",
    ],
    ["gnutls_handshake() failed: The TLS connection was non-properly terminated.", "network"],
    ["SSL certificate problem: unable to get local issuer certificate", "network"],
    [
      "error: RPC failed; curl 35 OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
      "network",
    ],
    ["error: tls feature not enabled; use --features ssl", null],
    ["error[E0432]: unresolved import `openssl::ssl::SslConnector`", null],
    ["HTTP 502: Bad Gateway (https://api.github.com/graphql)", "network"],
    ["The requested URL returned error: 503", "network"],
    ["The requested URL returned error: 401", "auth"],
    ["error: 503 Service Unavailable", "network"],
    ['API Error: 500 {"type":"error"}', "network"],
    ["API Error: Connection error: ECONNREFUSED", "network"],
    ["TypeError: fetch failed", "network"],
    ["error connecting to api.github.com", "network"],
    ["HTTP 401: Bad credentials (https://api.github.com/user)", "auth"],
    ["fatal: Authentication failed for 'https://github.com/me/web.git/'", "auth"],
    ["Invalid API key · Please run /login", "auth"],
    ["OAuth token has expired", "auth"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/me/web.git/' not found", "auth"],
    ["fatal: not a git repository (or any of the parent directories): .git", null],
    ["GraphQL: Could not resolve to a PullRequest with the number of 9.", null],
    ["HTTP 404: Not Found", null],
    ["error: pathspec 'main' did not match", null],
    ["", null],
  ];
  for (const [text, want] of cases) expect(classifyFailure(text), text).toBe(want);
  // A failing step retries after 30, 60, 120, 240, then 300 s.
  expect([0, 1, 2, 3, 4, 5, 6].map(envBackoff)).toEqual([30, 60, 120, 240, 300, 300, 300]);
});

test("faults: a blip keeps looping", () => {
  const h = new Health();
  const t0 = 1_800_000_000;
  h.fail("github", DNS, t0);
  h.fail("github", "Connection reset by peer", t0 + 30);
  expect(h.open()).toEqual([{ kind: "github", since: t0, error: "Connection reset by peer" }]);
  // Under 15 minutes: picks go on, nothing to tell the owner.
  expect(h.blocked(t0 + 899)).toBe(false);
  expect(h.noticeDue(t0 + 899)).toBeNull();
  // The next success closes it; a new failure later starts afresh.
  h.ok("github");
  expect(h.open()).toEqual([]);
  h.fail("github", DNS, t0 + 1000);
  expect(h.blocked(t0 + 1000 + 600)).toBe(false);
});

test("faults: one message after 15 minutes", () => {
  const h = new Health();
  const t0 = 1_800_000_000;
  h.fail("claude", "Invalid API key · Please run /login", t0);
  h.fail("github", DNS, t0 + 60);
  expect(h.blocked(t0 + 899)).toBe(false);
  expect(h.blocked(t0 + 900)).toBe(true);
  // One notice per episode, about the oldest blocking fault.
  expect(h.noticeDue(t0 + 900)).toMatchObject({ kind: "claude", since: t0 });
  expect(h.noticeDue(t0 + 960)).toBeNull();
  expect(h.noticeDue(t0 + 5000)).toBeNull();
  // The episode lasts until every kind is closed.
  h.ok("claude");
  expect(h.blocked(t0 + 5000)).toBe(true);
  expect(h.noticeDue(t0 + 5000)).toBeNull();
  h.ok("github");
  expect(h.blocked(t0 + 5000)).toBe(false);
  // A new episode sends a new message.
  h.fail("github", DNS, t0 + 6000);
  expect(h.noticeDue(t0 + 6000 + 900)).toMatchObject({ kind: "github" });
  expect(fixFor("claude")).toContain("/login");
  expect(fixFor("tool:npm")).toBe("install npm on the service's PATH");
});

test("faults: a missing tool is a fault", () => {
  expect(classifyRun("$ npm ci\nsh: 1: npm: not found\n")).toEqual({
    kind: "tool:npm",
    why: "sh: 1: npm: not found",
  });
  expect(classifyRun("bash: cargo: command not found")?.kind).toBe("tool:cargo");
  expect(
    classifyRun("  = note: /home/me/.local/bin/cc: 12: exec: /home/me/.local/zig-0.16.0/zig: not found")
      ?.kind,
  ).toBe("tool:zig");
  expect(classifyRun("bwrap: setting up uid map: Permission denied")).toEqual({
    kind: "sandbox",
    why: "bwrap: setting up uid map: Permission denied",
  });
  expect(classifyRun("Error: apply-seccomp failed")?.kind).toBe("sandbox");
  expect(classifyRun("which provider?")).toBeNull();
  expect(classifyRun("src/login.rs: not found in the plan")).toBeNull();
});
